'use strict';

/**
 * Extracts a DOT graph showing Promise relationships and function call flows from the c42 Document IR.
 */
function extractPromiseGraph(document) {
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
  const createdPromises = new Set();

  function safeId(str) {
    if (!str) return 'node_unknown';
    return 'node_' + str.trim().replace(/[^a-zA-Z0-9_]/g, '_');
  }

  // Pre-collect all function definition names for call graph tracking
  const funcDefs = document.getElementsByType('function_definition');
  funcDefs.forEach(fn => {
    const decl = fn.field('declarator');
    const idNode = decl && decl.children.find(c => c.type === 'identifier');
    if (idNode) knownFunctions.add(idNode.textContent.trim());
  });

  function getContextName(node) {
    const closure = node.closest('closure_expression');
    const funcNode = node.closest('function_definition');
    
    let parentName = 'global';
    if (funcNode) {
      const decl = funcNode.field('declarator');
      const idNode = decl && decl.children.find(c => c.type === 'identifier');
      parentName = idNode ? idNode.textContent : 'anonymous_function';
    }

    if (closure) {
      const nameNode = closure.children.find(c => c.type === 'identifier');
      const closureName = nameNode ? nameNode.textContent : 'anonymous';
      return `closure_${closureName}_in_${parentName}`;
    }
    
    return parentName;
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

  // Record an individual interaction edge as its own discrete line
  function addEdge(ctxId, targetId, labelText, customAttributes = {}) {
    const lower = labelText.toLowerCase();
    
    if (promises.has(targetId)) {
      if (!promiseFirstContext.has(targetId)) {
        promiseFirstContext.set(targetId, ctxId);
      }
      if (lower.includes('created')) {
        createdPromises.add(targetId);
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

    // Determine direction: Await and Subscribed flow from Promise -> Context
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

  // 1. Find standard promise library calls and function calls
  const callExpressions = document.getElementsByType('call_expression');
  
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

    if (targetName === 'newPromise' || targetName.startsWith('promise_timeout_reject')) {
      const assignment = call.closest('init_declarator');
      if (assignment) {
        const pNode = assignment.children.find(c => c.type === 'identifier');
        if (pNode) {
          const pId = addPromise(pNode.textContent.trim());
          addEdge(ctxId, pId, `created (${targetName})`);
        }
      }
    } else if (targetName === 'promise_ping') {
      const pId = addPromise(primaryArgLabel);
      addEdge(ctxId, pId, 'pinged');
    } else if (targetName === 'promise_cancel') {
      const pId = addPromise(primaryArgLabel);
      addEdge(ctxId, pId, 'canceled');
    } else if (targetName === 'promise_resolve') {
      const pId = addPromise(primaryArgLabel);
      addEdge(ctxId, pId, 'resolved');
    } else if (targetName === 'promise_reject') {
      const pId = addPromise(primaryArgLabel);
      addEdge(ctxId, pId, 'rejected');
    } else if (targetName === 'promise_then') {
      const pId = addPromise(primaryArgLabel);
      const hasRejectHandler = argNodes.length > 2;
      const arrowheadStyle = hasRejectHandler ? 'diamond' : '';
      addEdge(ctxId, pId, 'subscribed (promise_then)', { arrowhead: arrowheadStyle });
    } else if (targetName === 'promise_unsubscribe') {
      const pId = addPromise(primaryArgLabel);
      addEdge(ctxId, pId, 'unsubscribed');
    } else if (targetName === 'promise_do_op') {
      const targetProm = argsTexts.length > 1 ? argsTexts[1] : primaryArgLabel;
      const pId = addPromise(targetProm);
      addEdge(ctxId, pId, 'do_op');
    }
  });

  // 2. Find manual await declarations
  const awaits = document.getElementsByType('declaration').filter(d => 
    d.children.some(c => c.textContent && c.textContent.trim() === 'await')
  );

  awaits.forEach(awaitNode => {
    const ctxId = addContext(getContextName(awaitNode));
    const call = awaitNode.querySelector(n => n.type === 'call_expression' || n.type === 'function_declarator');
    
    if (call) {
      const targetName = call.children[0].textContent;

      if (targetName === 'PROMISE_RACE') {
        const paramList = call.querySelector(n => n.type === 'parameter_list');
        if (paramList) {
          const params = paramList.querySelectorAll(n => n.type === 'parameter_declaration');
          params.forEach(param => {
            const pId = addPromise(param.textContent.trim());
            addEdge(ctxId, pId, 'awaited (PROMISE_RACE)');
          });
        }
      } else if (targetName === 'CLOSURE_CANCEL') {
        const paramList = call.querySelector(n => n.type === 'parameter_list');
        const paramArg = paramList ? paramList.textContent.replace(/[()]/g, '').trim() : 'closure';
        const pId = addPromise(paramArg);
        addEdge(ctxId, pId, 'canceled');
      } else {
        const pId = addPromise(call.textContent.trim());
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
      const pId = addPromise(promiseName);
      const ctxId = addContext(getContextName(assign));
      const rightSide = assign.children[assign.children.length - 1].textContent.trim();
      addEdge(ctxId, pId, `pinged (${rightSide})`);
    }
  });

  // Ensure every promise has a creation link
  promises.forEach((label, pId) => {
    if (!createdPromises.has(pId)) {
      const ctxId = promiseFirstContext.get(pId) || addContext('global');
      addEdge(ctxId, pId, 'created (inferred)');
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