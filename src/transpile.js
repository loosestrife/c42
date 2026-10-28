'use strict';

const { textNode } = require('./ir');

// ---------------------------------------------------------------------------
// Helpers for inspecting and manipulating IrNodes
// ---------------------------------------------------------------------------

function getFunctionName(fnNode) {
  const decl = fnNode.field('declarator');
  if (!decl) return null;
  const id = decl.children.find(c => c.type === 'identifier') ||
    decl.querySelector(n => n.type === 'identifier');
  return id ? id.textContent.trim() : null;
}

function isAsyncFunction(fnNode) {
  return fnNode.children.some(
    c => c.type === 'type_qualifier' && c.textContent.trim() === 'async'
  );
}

function isContextDeclaration(declNode) {
  return declNode.children.some(
    c => c.type === 'storage_class_specifier' && c.textContent.trim() === '_context'
  );
}

function extractDeclarationInfo(declNode) {
  // Extract type text, variable name, whether it is an unsized array, and initializer expression text
  const typeParts = [];
  let initDecl = null;
  let plainDecl = null;

  for (const child of declNode.children) {
    if (child.type === 'storage_class_specifier' && child.textContent.trim() === '_context') {
      continue;
    }
    if (child.type === 'init_declarator') {
      initDecl = child;
    } else if (
      ['identifier', 'pointer_declarator', 'array_declarator', 'function_declarator'].includes(child.type)
    ) {
      plainDecl = child;
    } else if (child.type !== ';' && child.type !== 'extra' && child.type !== 'whitespace') {
      typeParts.push(child.textContent.trim());
    }
  }

  const baseType = typeParts.join(' ');
  const declaratorNode = initDecl ? initDecl.field('declarator') || initDecl.children[0] : plainDecl;
  const valueNode = initDecl ? initDecl.field('value') || initDecl.children[initDecl.children.length - 1] : null;

  let varName = null;
  if (declaratorNode) {
    const idNode = declaratorNode.type === 'identifier'
      ? declaratorNode
      : declaratorNode.querySelector(n => n.type === 'identifier');
    if (idNode) varName = idNode.textContent.trim();
  }

  let declText = declaratorNode ? declaratorNode.textContent.trim() : varName;
  // Convert unsized array declarator like `* s[]` to `**s` for struct fields
  const hasUnsizedArray = declaratorNode &&
    declaratorNode.querySelector(n => n.type === 'array_declarator' && !n.field('size'));
  let structFieldDecl = `${baseType} ${declText}`;
  if (hasUnsizedArray) {
    structFieldDecl = `${baseType} **${varName}`;
  }

  return {
    baseType,
    varName,
    declaratorText: declText,
    structFieldDecl,
    initNode: valueNode,
    initText: valueNode ? valueNode.textContent.trim() : null,
  };
}

function rewriteIdentifiersInNode(rootNode, varMap) {
  const ids = rootNode.querySelectorAll(
    n => (n.type === 'identifier' || n.type === 'field_identifier') && n.text !== null
  );
  for (const id of ids) {
    const name = id.text.trim();
    if (!varMap.has(name)) continue;

    // Skip if this identifier is the right-hand field name of `.` or `->`
    if (id.parent && id.parent.type === 'field_expression') {
      const fieldChild = id.parent.field('field') || id.parent.children[id.parent.children.length - 1];
      if (fieldChild === id) continue;
    }

    // Skip if this identifier is a function declaration name
    if (id.parent && id.parent.type === 'function_declarator' && id.parent.children[0] === id) {
      continue;
    }

    id.text = varMap.get(name);
  }
}

// ---------------------------------------------------------------------------
// Pass 1: Strip numeric underscores (1_000_000 -> 1000000)
// ---------------------------------------------------------------------------

function stripNumberUnderscores(doc, c42Opts) {
  if (c42Opts.number?.stripUnderscores === false) return;
  const nums = doc.getElementsByType('number_literal');
  for (const num of nums) {
    if (num.text && num.text.includes('_')) {
      num.text = num.text.replace(/_/g, '');
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2: Custom printf format specifiers (%erb, %er -> %s + c42_format_error)
// ---------------------------------------------------------------------------

function transformFormatStrings(doc) {
  const calls = doc.getElementsByType('call_expression');
  for (const call of calls) {
    const fnNode = call.field('function') || call.children[0];
    if (!fnNode || fnNode.textContent.trim() !== 'printf') continue;

    const argList = call.field('arguments') || call.querySelector(n => n.type === 'argument_list');
    if (!argList) continue;

    const argNodes = argList.children.filter(
      c => !['(', ')', ',', 'whitespace', 'extra'].includes(c.type)
    );
    if (argNodes.length < 2) continue;

    const fmtNode = argNodes[0];
    if (fmtNode.type !== 'string_literal') continue;

    const contents = fmtNode.getElementsByType('string_content');
    let replaced = false;
    for (const content of contents) {
      if (content.text && (content.text.includes('%erb') || content.text.includes('%er'))) {
        content.text = content.text.replace(/%erb/g, '%s').replace(/%er/g, '%s');
        replaced = true;
      }
    }

    if (replaced && argNodes[1]) {
      const errArgText = argNodes[1].textContent.trim();
      argNodes[1].replaceWith(textNode(`c42_format_error(${errArgText})`));
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 3: Pointer Nullability (*! and *?)
// ---------------------------------------------------------------------------

function transformPointers(doc, c42Opts) {
  const fnAssertMap = new Map(); // function_definition -> Set<string>
  const ptrDecls = doc.getElementsByType('pointer_declarator');

  for (const ptr of ptrDecls) {
    const opChild = ptr.children.find(c => c.text === '*!' || c.text === '*?');
    if (!opChild) continue;

    if (opChild.text === '*!') {
      if (!c42Opts.pointer?.nonNullSyntax) {
        throw new Error("Found '*!' syntax, but pointer.nonNullSyntax is disabled in c42.json");
      }
      opChild.text = '*';

      if (c42Opts.pointer?.nonNullRuntimeAssert) {
        const idNode = ptr.querySelector(n => n.type === 'identifier');
        const varName = idNode ? idNode.textContent.trim() : null;
        if (varName) {
          const paramDecl = ptr.closest('parameter_declaration');
          const fnDef = ptr.closest('function_definition');
          if (paramDecl && fnDef) {
            if (!fnAssertMap.has(fnDef)) fnAssertMap.set(fnDef, new Set());
            fnAssertMap.get(fnDef).add(varName);
          } else {
            const compound = ptr.closest('compound_statement');
            if (compound) {
              let stmt = ptr;
              while (stmt.parent && stmt.parent !== compound) {
                stmt = stmt.parent;
              }
              if (stmt.parent === compound) {
                compound.insertAfter(textNode(`\n  assert(${varName} != NULL);`), stmt);
              }
            }
          }
        }
      }
    } else if (opChild.text === '*?') {
      if (!c42Opts.pointer?.nullableSyntax) {
        throw new Error("Found '*?' syntax, but pointer.nullableSyntax is disabled in c42.json");
      }
      opChild.text = '*';
    }
  }

  for (const [fnDef, vars] of fnAssertMap.entries()) {
    const body = fnDef.field('body') || fnDef.children.find(c => c.type === 'compound_statement');
    if (!body || body.children.length === 0) continue;
    const openBrace = body.children[0];
    const assertsText = Array.from(vars)
      .map(v => `\n  assert(${v} != NULL);`)
      .join('');
    body.insertAfter(textNode(assertsText), openBrace);
  }
}

// ---------------------------------------------------------------------------
// Pass 4: Lower `with(ctx) stmt` statements
// ---------------------------------------------------------------------------

function lowerWithStatements(doc) {
  // Process innermost with_statements first
  const withStmts = doc.getElementsByType('with_statement').reverse();
  for (const w of withStmts) {
    const ctxNode = w.field('context');
    const bodyNode = w.field('body');
    if (!ctxNode || !bodyNode) continue;

    const ctxExpr = ctxNode.textContent.trim();

    if (bodyNode.type === 'declaration') {
      const info = extractDeclarationInfo(bodyNode);
      if (info.varName && info.initText) {
        const replacement =
          `${info.baseType} ${info.declaratorText};\n` +
          `  {\n` +
          `    void *_c42_prev_ctx = CURRENT_SUSPEND_CONTEXT;\n` +
          `    CURRENT_SUSPEND_CONTEXT = &(${ctxExpr});\n` +
          `    ${info.varName} = ${info.initText};\n` +
          `    CURRENT_SUSPEND_CONTEXT = _c42_prev_ctx;\n` +
          `  }`;
        w.replaceWith(textNode(replacement));
        continue;
      }
    }

    const bodyText = bodyNode.textContent.trim();
    const replacement =
      `{\n` +
      `    void *_c42_prev_ctx = CURRENT_SUSPEND_CONTEXT;\n` +
      `    CURRENT_SUSPEND_CONTEXT = &(${ctxExpr});\n` +
      `    ${bodyText}\n` +
      `    CURRENT_SUSPEND_CONTEXT = _c42_prev_ctx;\n` +
      `  }`;
    w.replaceWith(textNode(replacement));
  }
}

// ---------------------------------------------------------------------------
// Pass 5: Hoist Closures, SuspendContexts, and Split Async State Machines
// ---------------------------------------------------------------------------

function transformClosuresAndAsyncFunctions(doc) {
  const functions = doc.getFunctions();
  const hoistedStructDefs = [];

  for (const fn of functions) {
    const fnName = getFunctionName(fn);
    if (!fnName) continue;

    const isAsync = isAsyncFunction(fn);
    const closures = fn.getElementsByType('closure_expression');
    const directContextDecls = fn
      .getElementsByType('declaration')
      .filter(d => isContextDeclaration(d) && !d.closest('closure_expression'));

    if (!isAsync && closures.length === 0 && directContextDecls.length === 0) {
      continue;
    }

    // Number or name closures in this function
    let anonIdx = 1;
    const closureMetas = closures.map(cl => {
      const nameNode = cl.field('name') || cl.children.find(c => c.type === 'identifier' && c !== cl.field('with'));
      const suffix = nameNode ? nameNode.textContent.trim() : String(anonIdx++);
      return {
        node: cl,
        nameNode,
        suffix,
        fnIdent: `Closure_${fnName}_${suffix}`,
        storageType: `ClosureStorage_${fnName}_${suffix}`,
        sizeIdent: `ClosureSize_${fnName}_${suffix}`,
      };
    });

    // Replace NEXT_CLOSURE_STORAGE declarations in lexical order
    const nextStorageNodes = fn
      .querySelectorAll(n => n.type === 'type_identifier' && n.textContent.trim() === 'NEXT_CLOSURE_STORAGE');
    nextStorageNodes.forEach((node, idx) => {
      const meta = closureMetas[idx] || closureMetas[0];
      if (meta) {
        node.text = meta.storageType;
      }
    });

    // Case 1: Vanilla function with a stateless closure (e.g. install_signal_handler)
    if (!isAsync && directContextDecls.length === 0 && closureMetas.length > 0) {
      const hoistedCode = [];
      for (const meta of closureMetas) {
        const block = meta.node.field('block') || meta.node.children.find(c => c.type === 'compound_statement');
        const paramsNode = meta.node.field('params');
        const paramsText = paramsNode ? paramsNode.textContent.trim() : '(int _c42_unused)';
        const bodyText = block ? block.textContent.trim() : '{}';

        hoistedCode.push(
          `typedef struct ${meta.storageType} {\n` +
          `  char _unused;\n` +
          `} ${meta.storageType};\n` +
          `const size_t ${meta.sizeIdent} = sizeof(${meta.storageType});\n` +
          `static void ${meta.fnIdent}${paramsText} {\n` +
          `  (void)_c42_unused;\n` +
          `  ${bodyText.slice(1, -1).trim()}\n` +
          `}\n\n`
        );
        meta.node.replaceWith(textNode(meta.fnIdent));
      }
      fn.parent.insertBefore(textNode(hoistedCode.join('')), fn);
      continue;
    }

    // Case 2: Twist function (synchronous function with _context vars and closures, e.g. callbacker_read)
    if (!isAsync && directContextDecls.length > 0) {
      const ctxStructName = `SuspendContext_${fnName}`;
      const ctxSizeName = `SuspendContextSize_${fnName}`;

      // Identify parameters of `fn` that are referenced inside closures
      const paramDecls = [];
      const fnDecl = fn.field('declarator');
      const paramList = fnDecl && fnDecl.querySelector(n => n.type === 'parameter_list');
      if (paramList && paramList.parent === fnDecl) {
        for (const p of paramList.children) {
          if (p.type === 'parameter_declaration') {
            const pText = p.textContent.trim();
            // Extract parameter identifier
            const pIds = p.querySelectorAll(n => n.type === 'identifier');
            const pId = pIds.length > 0 ? pIds[0].textContent.trim() : null;
            if (pId) {
              paramDecls.push({ name: pId, declText: pText });
            }
          }
        }
      }

      // Collect _context variable info
      const ctxVars = directContextDecls.map(extractDeclarationInfo);
      const varMap = new Map();
      for (const v of ctxVars) {
        if (v.varName) varMap.set(v.varName, `_c42_ctx->${v.varName}`);
      }

      // Check which parameters are used inside any closure
      const capturedParams = [];
      for (const p of paramDecls) {
        const usedInClosure = closureMetas.some(m =>
          m.node.querySelector(n => n.type === 'identifier' && n.textContent.trim() === p.name)
        );
        if (usedInClosure) {
          capturedParams.push(p);
          varMap.set(p.name, `_c42_ctx->${p.name}`);
        }
      }

      // Build closure storage & hoisted closure functions
      const closureStructDefs = [];
      const closureFnDefs = [];

      for (const meta of closureMetas) {
        closureStructDefs.push(
          `typedef struct ${ctxStructName} ${ctxStructName};\n` +
          `typedef struct ${meta.storageType} {\n` +
          `  C42ClosureHeader _c42_hdr;\n` +
          `  ${ctxStructName} *_parent_ctx;\n` +
          `  void *e;\n` +
          `} ${meta.storageType};\n` +
          `const size_t ${meta.sizeIdent} = sizeof(${meta.storageType});\n`
        );

        const blockNode = meta.node.field('block') || meta.node.children.find(c => c.type === 'compound_statement');
        const catchNode = meta.node.field('catch') || meta.node.children.find(c => c.type === 'catch_clause');

        const closureVarMap = new Map(varMap);
        closureVarMap.set('THIS_CLOSURE', '_c42_self');

        if (blockNode) {
          rewriteIdentifiersInNode(blockNode, closureVarMap);
          const innerBody = blockNode.textContent.trim().slice(1, -1).trim();
          closureFnDefs.push(
            `static void ${meta.fnIdent}(void *_c42_self) {\n` +
            `  ${meta.storageType} *_c42_cl = (${meta.storageType} *)_c42_self;\n` +
            `  ${ctxStructName} *_c42_ctx = _c42_cl->_parent_ctx;\n` +
            `  (void)_c42_ctx;\n` +
            `  ${innerBody}\n` +
            `}\n`
          );
        }

        if (catchNode) {
          const catchBody = catchNode.field('body') || catchNode.children.find(c => c.type === 'compound_statement');
          rewriteIdentifiersInNode(catchBody, closureVarMap);

          const whileStmt = catchBody.children.find(c => c.type === 'while_statement');
          if (whileStmt && whileStmt.querySelector(n => n.type === 'await')) {
            // Split catch block around the async while loop
            const stmts = catchBody.children.filter(
              c => !['{', '}', 'extra', 'whitespace'].includes(c.type)
            );
            const whileIdx = stmts.indexOf(whileStmt);
            const preWhileText = stmts.slice(0, whileIdx).map(s => s.textContent.trim()).join('\n  ');
            const postWhileText = stmts.slice(whileIdx + 1).map(s => s.textContent.trim()).join('\n  ');

            const condNode = whileStmt.field('condition');
            const condText = condNode ? condNode.textContent.trim() : '(0)';
            const awaitCall = whileStmt.querySelector(n => n.type === 'unary_expression');
            const awaitedExpr = awaitCall
              ? awaitCall.children[awaitCall.children.length - 1].textContent.trim()
              : 'promise_timeout(0)';

            closureFnDefs.push(
              `static void ${meta.fnIdent}_catch_loop(void *_c42_self, Promise _c42_settled) {\n` +
              `  (void)_c42_settled;\n` +
              `  ${meta.storageType} *_c42_cl = (${meta.storageType} *)_c42_self;\n` +
              `  ${ctxStructName} *_c42_ctx = _c42_cl->_parent_ctx;\n` +
              `  if ${condText} {\n` +
              `    c42_await_promise(${awaitedExpr}, ${meta.fnIdent}_catch_loop, _c42_self);\n` +
              `    return;\n` +
              `  }\n` +
              `  ${postWhileText}\n` +
              `}\n` +
              `static void ${meta.fnIdent}_catch_start(void *_c42_self, void *e) {\n` +
              `  ${meta.storageType} *_c42_cl = (${meta.storageType} *)_c42_self;\n` +
              `  _c42_cl->e = e;\n` +
              `  ${preWhileText}\n` +
              `  ${meta.fnIdent}_catch_loop(_c42_self, NULL);\n` +
              `}\n`
            );
          }

          // Replace promise_then(prom, ^{...} catch(e) {...}) call with c42_promise_then
          const callExpr = meta.node.closest('call_expression');
          if (callExpr && callExpr.children[0].textContent.trim() === 'promise_then') {
            const argList = callExpr.field('arguments');
            const argNodes = argList.children.filter(
              c => !['(', ')', ',', 'whitespace', 'extra'].includes(c.type)
            );
            const promText = argNodes[0].textContent.trim();
            callExpr.replaceWith(
              textNode(
                `(_c42_ctx->closureStorageAllocation._parent_ctx = _c42_ctx, ` +
                `c42_promise_then(${promText}, &_c42_ctx->closureStorageAllocation, ${meta.fnIdent}, ${meta.fnIdent}_catch_start))`
              )
            );
          }
        }
      }

      // Build SuspendContext struct definition
      const structFields = [
        `  void *_c42_previousSuspendContext;`,
        ...capturedParams.map(p => `  ${p.declText};`),
        ...ctxVars.map(v => `  ${v.structFieldDecl};`),
      ];
      const suspendStructDef =
        `${closureStructDefs.join('\n')}` +
        `struct ${ctxStructName} {\n` +
        `${structFields.join('\n')}\n` +
        `};\n` +
        `const size_t ${ctxSizeName} = sizeof(${ctxStructName});\n\n`;

      hoistedStructDefs.push(suspendStructDef);

      // Rewrite _context declarations and variable uses in `fn`
      const fnBody = fn.field('body');
      rewriteIdentifiersInNode(fnBody, varMap);

      for (const decl of directContextDecls) {
        const info = extractDeclarationInfo(decl);
        if (info.initText) {
          decl.replaceWith(textNode(`${info.varName} = ${info.initText};`));
        } else {
          decl.replaceWith(textNode(`/* _context ${info.varName} in ${ctxStructName} */`));
        }
      }

      // Prepend context setup to fnBody
      const openBrace = fnBody.children[0];
      const paramAssigns = capturedParams
        .map(p => `\n  _c42_ctx->${p.name} = ${p.name};`)
        .join('');
      const ctxInitCode =
        `\n  ${ctxStructName} *_c42_ctx = CURRENT_SUSPEND_CONTEXT\n` +
        `    ? (${ctxStructName} *)memset(CURRENT_SUSPEND_CONTEXT, 0, sizeof(${ctxStructName}))\n` +
        `    : (${ctxStructName} *)calloc(1, sizeof(${ctxStructName}));` +
        paramAssigns;
      fnBody.insertAfter(textNode(ctxInitCode), openBrace);

      // Emit struct definitions + closure functions before `fn`
      fn.parent.insertBefore(textNode(suspendStructDef + closureFnDefs.join('\n') + '\n'), fn);
      continue;
    }

    // Case 3: Chocolate (async) function (e.g. my_async_function)
    if (isAsync) {
      const ctxStructName = `SuspendContext_${fnName}`;
      const ctxSizeName = `SuspendContextSize_${fnName}`;

      // Collect direct _context declarations in fn
      const ctxVars = directContextDecls.map(extractDeclarationInfo);

      // Also lift Promise declarations that span await points (like `p` and `timeout`)
      const fnBody = fn.field('body');
      const promiseDecls = fnBody
        .getElementsByType('declaration')
        .filter(
          d =>
            !isContextDeclaration(d) &&
            !d.closest('closure_expression') &&
            d.children.some(c => c.type === 'type_identifier' && c.textContent.trim() === 'Promise')
        );
      const promiseVars = promiseDecls.map(extractDeclarationInfo);

      // Build closure storage structs and functions for closures inside this async function
      const closureStructDefs = [];
      const closureFnDefs = [];
      const namedClosureStorageMap = new Map(); // closure name -> storage var name in ctx

      for (const meta of closureMetas) {
        const clContextDecls = meta.node
          .getElementsByType('declaration')
          .filter(isContextDeclaration);
        const clVars = clContextDecls.map(extractDeclarationInfo);

        const withExprNode = meta.node.field('with');
        const storageVarName = withExprNode ? withExprNode.textContent.trim() : 'closureStorageAllocation';
        if (meta.nameNode) {
          namedClosureStorageMap.set(meta.nameNode.textContent.trim(), storageVarName);
        }

        closureStructDefs.push(
          `typedef struct ${ctxStructName} ${ctxStructName};\n` +
          `typedef struct ${meta.storageType} {\n` +
          `  C42ClosureHeader _c42_hdr;\n` +
          `  ${ctxStructName} *_parent_ctx;\n` +
          `${clVars.map(v => `  ${v.structFieldDecl};`).join('\n')}\n` +
          `} ${meta.storageType};\n` +
          `const size_t ${meta.sizeIdent} = sizeof(${meta.storageType});\n` +
          `static _Thread_local ${meta.storageType} *_c42_active_${meta.fnIdent} = NULL;\n`
        );

        const clBlock = meta.node.field('block') || meta.node.children.find(c => c.type === 'compound_statement');
        const paramsNode = meta.node.field('params');
        const paramsText = paramsNode ? paramsNode.textContent.trim() : '(void)';

        for (const cd of clContextDecls) {
          const info = extractDeclarationInfo(cd);
          if (info.initText) {
            cd.replaceWith(textNode(`_c42_cl->${info.varName} = ${info.initText};`));
          } else {
            cd.remove();
          }
        }

        const clVarMap = new Map();
        for (const pv of promiseVars) {
          if (pv.varName) clVarMap.set(pv.varName, `_c42_ctx->${pv.varName}`);
        }
        for (const cv of ctxVars) {
          if (cv.varName) clVarMap.set(cv.varName, `_c42_ctx->${cv.varName}`);
        }
        for (const clv of clVars) {
          if (clv.varName) clVarMap.set(clv.varName, `_c42_cl->${clv.varName}`);
        }
        rewriteIdentifiersInNode(clBlock, clVarMap);

        const clBodyInner = clBlock.textContent.trim().slice(1, -1).trim();
        closureFnDefs.push(
          `static void ${meta.fnIdent}${paramsText} {\n` +
          `  ${meta.storageType} *_c42_cl = _c42_active_${meta.fnIdent};\n` +
          `  ${ctxStructName} *_c42_ctx = _c42_cl->_parent_ctx;\n` +
          `  ${clBodyInner}\n` +
          `}\n`
        );

        meta.node.replaceWith(
          textNode(
            `(_c42_ctx->${storageVarName}._parent_ctx = _c42_ctx, ` +
            `_c42_active_${meta.fnIdent} = &_c42_ctx->${storageVarName}, ` +
            `${meta.fnIdent})`
          )
        );
      }

      // Rewrite named closure field accesses like `foo->nread` to `_c42_ctx->closureStorageAllocation.nread`
      const fieldExprs = fnBody.getElementsByType('field_expression');
      for (const fe of fieldExprs) {
        const arg = fe.field('argument') || fe.children[0];
        const field = fe.field('field') || fe.children[fe.children.length - 1];
        if (arg && field && namedClosureStorageMap.has(arg.textContent.trim())) {
          const storageVar = namedClosureStorageMap.get(arg.textContent.trim());
          fe.replaceWith(textNode(`_c42_ctx->${storageVar}.${field.textContent.trim()}`));
        }
      }

      // Build SuspendContext struct for the async function
      const structFields = [
        `  void *_c42_previousSuspendContext;`,
        `  Promise _c42_return_promise;`,
        ...promiseVars.map(v => `  ${v.structFieldDecl};`),
        ...ctxVars.map(v => `  ${v.structFieldDecl};`),
      ];
      const suspendStructDef =
        `${closureStructDefs.join('\n')}` +
        `struct ${ctxStructName} {\n` +
        `${structFields.join('\n')}\n` +
        `};\n` +
        `const size_t ${ctxSizeName} = sizeof(${ctxStructName});\n` +
        `Promise ${fnName}(void);\n\n`;

      // Hoist the struct definition and prototype before the first function that references it (e.g. `main`)
      const firstCaller = functions.find(otherFn =>
        otherFn !== fn && otherFn.textContent.includes(fnName)
      ) || fn;
      firstCaller.parent.insertBefore(textNode(suspendStructDef), firstCaller);

      // Rewrite all variable references in fnBody to `_c42_ctx-><var>`
      const fnVarMap = new Map();
      for (const v of [...ctxVars, ...promiseVars]) {
        if (v.varName) fnVarMap.set(v.varName, `_c42_ctx->${v.varName}`);
      }
      rewriteIdentifiersInNode(fnBody, fnVarMap);

      // Replace _context and Promise declarations in fnBody with assignments
      for (const decl of [...directContextDecls, ...promiseDecls]) {
        const info = extractDeclarationInfo(decl);
        if (info.initText) {
          decl.replaceWith(textNode(`${info.varName} = ${info.initText};`));
        } else {
          decl.replaceWith(textNode(`/* _context ${info.varName} in ${ctxStructName} */`));
        }
      }

      lowerWithStatements(fnBody);

      // Split fnBody statements into pre-loop (`_start`), loop body (`_loop`), and try/catch/else continuations
      const topStmts = fnBody.children.filter(
        c => !['{', '}', 'extra', 'whitespace'].includes(c.type)
      );
      const doStmt = topStmts.find(s => s.type === 'do_statement');
      const doIdx = topStmts.indexOf(doStmt);
      const preLoopStmts = doIdx >= 0 ? topStmts.slice(0, doIdx) : topStmts;
      const preLoopText = preLoopStmts.map(s => s.textContent.trim()).join('\n  ');

      // Extract parts of the `do { ... } while (cond);` statement
      const doBody = doStmt.field('body');
      const doCond = doStmt.field('condition');
      const doCondText = doCond ? doCond.textContent.trim() : '(0)';

      const doBodyStmts = doBody.children.filter(
        c => !['{', '}', 'extra', 'whitespace'].includes(c.type)
      );
      const tryStmt = doBodyStmts.find(s => s.type === 'try_statement');
      const tryIdx = doBodyStmts.indexOf(tryStmt);
      const preTryText = doBodyStmts.slice(0, tryIdx).map(s => s.textContent.trim()).join('\n  ');

      // Extract PROMISE_RACE arguments in `try`
      const tryBody = tryStmt.field('body');
      const raceCall = tryBody.querySelector(
        n => n.type === 'call_expression' && n.children[0].textContent.trim() === 'PROMISE_RACE'
      );
      const raceArgs = raceCall
        .field('arguments')
        .children.filter(c => !['(', ')', ',', 'whitespace', 'extra'].includes(c.type))
        .map(n => n.textContent.trim());

      // Extract `catch (e)` and split around `await CLOSURE_CANCEL(...)`
      const catchClause = tryStmt.field('catch');
      const catchException = catchClause.field('exception').textContent.trim();
      const catchBody = catchClause.field('body');
      let catchCondText = null;
      let cancelContainer = catchBody;
      const topCatchStmts = catchBody.children.filter(
        c => !['{', '}', 'extra', 'whitespace'].includes(c.type)
      );
      if (
        topCatchStmts.length === 1 &&
        topCatchStmts[0].type === 'if_statement' &&
        topCatchStmts[0].textContent.includes('CLOSURE_CANCEL')
      ) {
        catchCondText = topCatchStmts[0].field('condition').textContent.trim();
        cancelContainer = topCatchStmts[0].field('consequence');
      }

      const catchStmts = cancelContainer.children.filter(
        c => !['{', '}', 'extra', 'whitespace'].includes(c.type)
      );
      const cancelStmtIdx = catchStmts.findIndex(s => s.textContent.includes('CLOSURE_CANCEL'));
      const preCancelText = catchStmts.slice(0, cancelStmtIdx).map(s => s.textContent.trim()).join('\n      ');
      const postCancelText = catchStmts.slice(cancelStmtIdx + 1).map(s => s.textContent.trim()).join('\n  ');

      const cancelCall = catchStmts[cancelStmtIdx].querySelector(
        n => n.type === 'call_expression' && n.children[0].textContent.trim() === 'CLOSURE_CANCEL'
      );
      const cancelTarget = cancelCall
        .field('arguments')
        .children.find(c => !['(', ')', ',', 'whitespace', 'extra'].includes(c.type))
        .textContent.trim();

      const catchBranchBody = catchCondText
        ? `    if ${catchCondText} {\n` +
          `      ${preCancelText}\n` +
          `      c42_await_closure_cancel(&(${cancelTarget}), ${fnName}_after_cancel, _c42_ctx);\n` +
          `      return;\n` +
          `    }`
        : `    ${preCancelText}\n` +
          `    c42_await_closure_cancel(&(${cancelTarget}), ${fnName}_after_cancel, _c42_ctx);\n` +
          `    return;`;

      // Extract `else` block and rewrite `return;` to resolve `_c42_return_promise`
      const elseClause = tryStmt.field('else');
      const elseBody = elseClause.children.find(c => c.type === 'compound_statement');
      for (const ret of elseBody.getElementsByType('return_statement')) {
        ret.replaceWith(textNode(`{ promise_resolve(_c42_ctx->_c42_return_promise, NULL); return; }`));
      }
      const elseInnerText = elseBody.textContent.trim().slice(1, -1).trim();

      const splitFunctionsCode =
        `${closureFnDefs.join('\n')}\n` +
        `static void ${fnName}_loop(${ctxStructName} *_c42_ctx);\n` +
        `static void ${fnName}_after_race(void *_c42_raw_ctx, Promise _c42_settled);\n` +
        `static void ${fnName}_after_cancel(void *_c42_raw_ctx, Promise _c42_settled);\n\n` +
        `static void ${fnName}_loop_check(${ctxStructName} *_c42_ctx) {\n` +
        `  if ${doCondText} {\n` +
        `    ${fnName}_loop(_c42_ctx);\n` +
        `  } else {\n` +
        `    promise_resolve(_c42_ctx->_c42_return_promise, NULL);\n` +
        `  }\n` +
        `}\n\n` +
        `static void ${fnName}_after_cancel(void *_c42_raw_ctx, Promise _c42_settled) {\n` +
        `  (void)_c42_settled;\n` +
        `  ${ctxStructName} *_c42_ctx = (${ctxStructName} *)_c42_raw_ctx;\n` +
        `  ${postCancelText}\n` +
        `  ${fnName}_loop_check(_c42_ctx);\n` +
        `}\n\n` +
        `static void ${fnName}_after_race(void *_c42_raw_ctx, Promise _c42_settled) {\n` +
        `  ${ctxStructName} *_c42_ctx = (${ctxStructName} *)_c42_raw_ctx;\n` +
        `  promise_unsubscribe(${raceArgs[0]}, _c42_ctx);\n` +
        `  promise_unsubscribe(${raceArgs[1]}, _c42_ctx);\n` +
        `  if (_c42_settled && _c42_settled->status == REJECTED) {\n` +
        `    void *${catchException} = _c42_settled->result;\n` +
        `${catchBranchBody}\n` +
        `  } else {\n` +
        `    ${elseInnerText}\n` +
        `  }\n` +
        `  ${fnName}_loop_check(_c42_ctx);\n` +
        `}\n\n` +
        `static void ${fnName}_loop(${ctxStructName} *_c42_ctx) {\n` +
        `  ${preTryText}\n` +
        `  c42_await_race2(${raceArgs[0]}, ${raceArgs[1]}, ${fnName}_after_race, _c42_ctx);\n` +
        `}\n\n` +
        `static void ${fnName}_start(${ctxStructName} *_c42_ctx) {\n` +
        `  ${preLoopText}\n` +
        `  ${fnName}_loop(_c42_ctx);\n` +
        `}\n\n` +
        `Promise ${fnName}(void) {\n` +
        `  ${ctxStructName} *_c42_ctx = CURRENT_SUSPEND_CONTEXT\n` +
        `    ? (${ctxStructName} *)memset(CURRENT_SUSPEND_CONTEXT, 0, sizeof(${ctxStructName}))\n` +
        `    : (${ctxStructName} *)calloc(1, sizeof(${ctxStructName}));\n` +
        `  _c42_ctx->_c42_return_promise = newPromise();\n` +
        `  ${fnName}_start(_c42_ctx);\n` +
        `  return _c42_ctx->_c42_return_promise;\n` +
        `}`;

      fn.replaceWith(textNode(splitFunctionsCode));
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point: transpile a c42 Document IR in-place
// ---------------------------------------------------------------------------

function transpileDocument(doc, c42Opts = {}) {
  stripNumberUnderscores(doc, c42Opts);
  transformFormatStrings(doc, c42Opts);
  transformPointers(doc, c42Opts);
  transformClosuresAndAsyncFunctions(doc, c42Opts);
  lowerWithStatements(doc, c42Opts);
  for (const td of doc.getElementsByType('type_definition')) {
    if (td.textContent.includes('struct Timer')) {
      td.replaceWith(textNode(`#ifndef C42_TIMER_DEFINED\n${td.textContent}\n#endif`));
    }
  }
  const firstInclude = doc.getElementsByType('preproc_include')[0];
  if (firstInclude && firstInclude.parent) {
    firstInclude.parent.insertBefore(
      textNode('#ifndef _DEFAULT_SOURCE\n#define _DEFAULT_SOURCE\n#endif\n'),
      firstInclude
    );
  }
  return doc.serialize();
}

module.exports = { transpileDocument };
