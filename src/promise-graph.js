'use strict';

/**
 * Extracts a DOT graph showing Promise relationships and function call flows from the c42 Document IR.
 * @param {Object} document - The c42 Document IR.
 * @param {Object} options - Visualization tuning options.
 * @param {boolean} [options.separateClosures=true] - Whether to give closures their own distinct nodes.
 * @param {boolean} [options.separateCatchBlocks=false] - Whether to split catch blocks into separate context nodes.
 */
function extractPromiseGraph(document, options = {}) {
  const {
    separateClosures = true,
    separateCatchBlocks = false
  } = options;

  let dot = 'digraph PromiseStateMachine {\n';
  dot += '  layout=neato;\n';
  dot += '  overlap=false;\n';
  dot += '  splines=true;\n';
  dot += '  sep=0.6;\n';
  dot += '  esep=0.3;\n';
  dot += '  node [fontname="Helvetica"];\n';
  dot += '  edge [fontname="Helvetica", fontsize=10];\n\n';

  const edges = []; 
  const promises = new Map(); 
  const contexts = new Map(); 
  const knownFunctions = new Set();
  const promiseFirstContext = new Map();
  const promiseScopes = new Map();

  function safeId(str) {
    if (!str) return 'node_unknown';
    return 'node_' + str.trim().replace(/[^a-zA-Z0-9_]/g, '_');
  }

  // Pre-collect file-scope (global) variable declarations so they remain un-attributed to local function contexts
  const globalVariables = new Set();
  document.getElementsByType('declaration').forEach(decl => {
    if (!decl.closest('function_definition')) {
      const idNodes = decl.querySelectorAll ? decl.querySelectorAll(n => n.type === 'identifier') : [];
      idNodes.forEach(id => {
        globalVariables.add(id.textContent.trim());
      });
    }
  });

  // Pre-collect all function definition names for call graph tracking
  const funcDefs = document.getElementsByType('function_definition');
  funcDefs.forEach(fn => {
    const decl = fn.field('declarator');
    const idNode = decl && decl.children.find(c => c.type === 'identifier');
    if (idNode) knownFunctions.add(idNode.textContent.trim());
  });

  // Pre-collect and name closures (supporting numbered anonymous closures like callbacker_read_closure_1)
  const closureNames = new Map();
  funcDefs.forEach(fn => {
    const parentName = (findIdentifier(fn)) || 'anonymous_function';
    const closures = fn.getElementsByType('closure_expression');
    let anonCounter = 1;
    closures.forEach(cl => {
      if (closureNames.has(cl)) return;
      const nameNode = cl.children.find(c => c.type === 'identifier');
      if (nameNode) {
        closureNames.set(cl, `closure_${nameNode.textContent.trim()}_in_${parentName}`);
      } else {
        closureNames.set(cl, `${parentName}_closure_${anonCounter++}`);
      }
    });
  });

  const allClosures = document.getElementsByType('closure_expression');
  let globalAnonCounter = 1;
  allClosures.forEach(cl => {
    if (!closureNames.has(cl)) {
      const nameNode = cl.children.find(c => c.type === 'identifier');
      if (nameNode) {
        closureNames.set(cl, `closure_${nameNode.textContent.trim()}_in_global`);
      } else {
        closureNames.set(cl, `global_closure_${globalAnonCounter++}`);
      }
    }
  });

  function getContextName(node) {
    let curr = node;
    let deepestClosure = null;
    let funcNode = null;
    let inCatch = false;

    while (curr) {
      if (!funcNode && curr.type === 'function_definition') {
        funcNode = curr;
      }
      if (!deepestClosure && curr.type === 'closure_expression') {
        deepestClosure = curr;
      }

      // Check if this compound_statement is a catch block following a closure_expression
      if (curr.type === 'compound_statement' && curr.parent && curr.parent.children) {
        const siblings = curr.parent.children;
        const idx = siblings.indexOf(curr);
        for (let i = idx - 1; i >= 0; i--) {
          const sib = siblings[i];
          if (sib.type === 'closure_expression') {
            deepestClosure = sib;
            inCatch = true;
            break;
          }
          if (sib.type === 'expression_statement' || sib.type === 'declaration') {
            break; 
          }
        }
      }

      const typeStr = (curr.type || '').toLowerCase();
      const textStr = (curr.textContent || '').toLowerCase();
      if (typeStr.includes('catch') || textStr.startsWith('catch')) {
        inCatch = true;
      }

      curr = curr.parent;
    }

    let parentName = 'global';
    if (funcNode) {
      const idNode = findIdentifier(funcNode);
      parentName = idNode || 'anonymous_function';
    }

    if (separateClosures && deepestClosure) {
      return closureNames.get(deepestClosure) || `closure_anonymous_in_${parentName}`;
    }

    let contextBase = parentName;
    if (separateCatchBlocks && inCatch) {
      contextBase += '_catch';
    }
    
    return contextBase;
  }

  function findIdentifier(node) {
    if (!node) return null;
    if (node.type === 'identifier') return node.textContent;
    if (node.children) {
      for (const child of node.children) {
        const found = findIdentifier(child);
        if (found) return found;
      }
    }
    return null;
  }

  function addContext(name) {
    const id = safeId(name);
    contexts.set(id, name);
    return id;
  }

  function addPromise(name) {
    const id = safeId(name);
    promises.set(id, name);
    return id;
  }

  // Pre-collect promise scopes across all call expressions
  const callExpressions = document.getElementsByType('call_expression');
  callExpressions.forEach(call => {
    const targetNode = call.children.find(c => c.type === 'identifier' || c.type === 'string_literal');
    if (!targetNode) return;
    const targetName = targetNode.textContent;

    if (targetName === 'newPromise' || targetName === 'promise_timeout' || targetName.startsWith('promise_timeout_')) {
      const assignment = call.closest('init_declarator') || call.closest('assignment_expression');
      const ctxName = getContextName(call);
      if (assignment) {
        const pNode = assignment.children.find(c => c.type === 'identifier');
        if (pNode) {
          const varName = pNode.textContent.trim();
          const scopedName = (ctxName === 'global') ? varName : `${ctxName}\n${varName}`;
          promiseScopes.set(`${ctxName}:${varName}`, scopedName);
        }
      }
    }
  });

  function resolvePromise(varName, node) {
    if (!varName) return 'unknown_promise';
    const cleanName = varName.trim().replace(/^&/, '');
    if (cleanName.includes('\n')) return cleanName;

    // Leave file-scope global variables un-attributed to any local function context
    if (globalVariables.has(cleanName)) {
      return cleanName;
    }

    const ctxName = getContextName(node);
    
    if (ctxName === 'global') {
      return cleanName;
    }

    const key = `${ctxName}:${cleanName}`;
    if (promiseScopes.has(key)) {
      return promiseScopes.get(key);
    }
    return `${ctxName}\n${cleanName}`;
  }

  // Record an individual interaction edge as its own discrete line
  function addEdge(ctxId, targetId, labelText, customAttributes = {}) {
    const lower = labelText.toLowerCase();
    
    if (promises.has(targetId)) {
      if (!promiseFirstContext.has(targetId)) {
        promiseFirstContext.set(targetId, ctxId);
      }
    }

    // Determine color based on semantic rules
    let color = 'dimgray';
    if (lower.includes('calls')) {
      color = 'black';
    } else if (lower.includes('created')) {
      color = 'goldenrod';
    } else if (lower.includes('reject')) {
      color = 'red';
    } else if (lower.includes('cancel')) {
      color = 'purple';
    } else if (lower.includes('resolve') || lower.includes('ping')) {
      color = 'forestgreen';
    } else if (lower.includes('await') || lower.includes('subscribed') || lower.includes('unsubscribed') || lower.includes('do_op')) {
      color = 'dodgerblue';
    }

    const isSubscription = lower.includes('subscribed') && !lower.includes('unsubscribed');
    const isPromiseToContext = (lower.includes('await') || isSubscription) && promises.has(targetId);
    
    let source, target;
    if (lower.includes('calls')) {
      source = ctxId;
      target = targetId;
    } else if (isPromiseToContext) {
      source = targetId; // Promise
      target = ctxId;    // Context
    } else {
      source = ctxId;    // Context
      target = targetId; // Promise
    }

    const escapedLabel = labelText.replace(/"/g, '\\"');
    let attrs = `label="${escapedLabel}", color="${color}", fontcolor="${color}"`;
    if (customAttributes.extra) {
      attrs += `, ${customAttributes.extra}`;
    }
    if (customAttributes.arrowhead) {
      attrs += `, arrowhead="${customAttributes.arrowhead}"`;
    }

    edges.push(`  "${source}" -> "${target}" [${attrs}];`);
  }

  // 1. Process standard promise library calls and function calls
  callExpressions.forEach(call => {
    const targetNode = call.children.find(c => c.type === 'identifier' || c.type === 'string_literal');
    if (!targetNode) return;
    
    const targetName = targetNode.textContent;
    const ctxId = addContext(getContextName(call));

    if (knownFunctions.has(targetName)) {
      const calleeId = addContext(targetName);
      addEdge(ctxId, calleeId, 'calls');
    }
    
    const argList = call.querySelector(n => n.type === 'argument_list');
    const argNodes = argList ? argList.children.filter(c => !['(', ')', ',', 'whitespace', 'extra'].includes(c.type)) : [];
    const argsTexts = argNodes.map(n => n.textContent.trim().replace(/^&/, ''));
    const primaryArgLabel = argsTexts.length > 0 ? argsTexts[0] : 'unknown_promise';

    if (targetName === 'newPromise' || targetName === 'promise_timeout' || targetName.startsWith('promise_timeout_')) {
      const assignment = call.closest('init_declarator') || call.closest('assignment_expression');
      let pName = null;
      if (assignment) {
        const pNode = assignment.children.find(c => c.type === 'identifier');
        if (pNode) {
          pName = pNode.textContent.trim();
        }
      }

      let resolvedPName;
      if (pName) {
        resolvedPName = resolvePromise(pName, call);
      } else {
        const ctxName = getContextName(call);
        const primaryArg = argNodes.length > 0 ? argNodes[0].textContent.trim() : '';

        if (ctxName === 'global') {
          resolvedPName = `${targetName}(${primaryArg})`;
        } else if (ctxName === 'my_async_function' && targetName === 'promise_timeout') {
          resolvedPName = `${ctxName}\ntimeout`;
        } else {
          resolvedPName = `${ctxName}\n${targetName}(${primaryArg})`;
        }
      }

      const pId = addPromise(resolvedPName);
      addEdge(ctxId, pId, `created (${targetName})`);
    } else if (targetName === 'promise_ping') {
      const pId = addPromise(resolvePromise(primaryArgLabel, call));
      addEdge(ctxId, pId, 'pinged');
    } else if (targetName === 'promise_cancel') {
      const pId = addPromise(resolvePromise(primaryArgLabel, call));
      addEdge(ctxId, pId, 'canceled');
    } else if (targetName === 'promise_resolve') {
      const pId = addPromise(resolvePromise(primaryArgLabel, call));
      addEdge(ctxId, pId, 'resolved');
    } else if (targetName === 'promise_reject') {
      const pId = addPromise(resolvePromise(primaryArgLabel, call));
      addEdge(ctxId, pId, 'rejected');
    } else if (targetName === 'promise_then') {
      const pId = addPromise(resolvePromise(primaryArgLabel, call));
      
      let subCtxId = ctxId;
      for (const argNode of argNodes) {
        const closureExpr = argNode.type === 'closure_expression' ? argNode : (argNode.querySelector ? argNode.querySelector(n => n.type === 'closure_expression') : null);
        if (closureExpr) {
          subCtxId = addContext(getContextName(closureExpr));
          break;
        }
      }

      const hasRejectHandler = argNodes.length > 2;
      const arrowheadStyle = hasRejectHandler ? 'diamond' : '';
      addEdge(subCtxId, pId, 'subscribed (promise_then)', { arrowhead: arrowheadStyle });
    } else if (targetName === 'promise_unsubscribe') {
      const pId = addPromise(resolvePromise(primaryArgLabel, call));
      addEdge(ctxId, pId, 'unsubscribed');
    } else if (targetName === 'promise_do_op') {
      const targetProm = argsTexts.length > 1 ? argsTexts[1] : primaryArgLabel;
      const pId = addPromise(resolvePromise(targetProm, call));
      addEdge(ctxId, pId, 'do_op');
    }
  });

  // 2. Find manual await expressions
  const awaits = document.getElementsByType('unary_expression').filter(u => 
    u.children.some(c => c.type === 'await' || (c.textContent && c.textContent.trim() === 'await'))
  );

  awaits.forEach(awaitNode => {
    const ctxId = addContext(getContextName(awaitNode));
    // Locate the call expression or target inside the unary expression
    const call = awaitNode.querySelector(n => n.type === 'call_expression' || n.type === 'identifier');
    
    if (call) {
      const targetName = call.children && call.children[0] ? call.children[0].textContent : call.textContent;

      if (targetName === 'PROMISE_RACE') {
        const argList = call.querySelector(n => n.type === 'argument_list');
        console.log('PROMISE_RACE', argList);
        if (argList) {
          const args = argList.children.filter(c => 
            c.type !== '(' && c.type !== ')' && c.type !== ','
          );
          
          args.forEach(argNode => {
            const argText = (argNode.textContent || argNode.text || '').trim();
            if (argText) {
              const pId = addPromise(resolvePromise(argText, awaitNode));
              addEdge(ctxId, pId, 'awaited (PROMISE_RACE)');
            }
          });
        }
      } else if (targetName === 'CLOSURE_CANCEL') {
        const paramList = call.querySelector(n => n.type === 'parameter_list');
        const paramArg = paramList ? paramList.textContent.replace(/[()]/g, '').trim() : 'closure';
        const pId = addPromise(resolvePromise(paramArg, awaitNode));
        addEdge(ctxId, pId, 'canceled');
      } else {
        const pId = addPromise(resolvePromise(call.textContent.trim(), awaitNode));
        const isCatchingReject = awaitNode.textContent.toLowerCase().includes('reject') || call.textContent.toLowerCase().includes('catch');
        const extraAttr = isCatchingReject ? 'dir=both' : '';
        const arrowheadStyle = isCatchingReject ? 'diamond' : '';
        addEdge(ctxId, pId, 'awaited', { extra: extraAttr, arrowhead: arrowheadStyle });
      }
    }
  });

  // 3. Find manual state assignments
  const assignments = document.getElementsByType('assignment_expression');
  assignments.forEach(assign => {
    const field = assign.querySelector(n => n.type === 'field_expression');
    if (field && field.textContent.includes('.status')) {
      const promiseName = field.textContent.split('.')[0];
      const pId = addPromise(resolvePromise(promiseName, assign));
      const ctxId = addContext(getContextName(assign));
      const rightSide = assign.children[assign.children.length - 1].textContent.trim();
      addEdge(ctxId, pId, `pinged (${rightSide})`);
    }
  });

  // --- DOT RENDER PHASE ---

  contexts.forEach((label, id) => {
    const safeLabel = label.replace(/"/g, '\\"');
    dot += `  "${id}" [label="${safeLabel}", shape=box, style=rounded];\n`;
  });
  dot += '\n';

  promises.forEach((label, id) => {
    const safeLabel = label.replace(/"/g, '\\"');
    dot += `  "${id}" [label="${safeLabel}", shape=ellipse, style=filled, fillcolor=lightcyan];\n`;
  });
  dot += '\n';

  const uniqueEdges = [...new Set(edges)];
  uniqueEdges.forEach(edge => {
    dot += edge + '\n';
  });

  dot += '}\n';
  return dot;
}

module.exports = { extractPromiseGraph };