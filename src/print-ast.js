const {inputFile, outputFile, c42Opts} = require('./opts');

function buildIR(node, source) {
  const irNode = {
    type: node.type,
    text: source.substring(node.startIndex, node.endIndex),
    children: [],
    parent: null
  };

  if (node.children.length === 0) {
    return irNode;
  }

  let lastIndex = node.startIndex;
  for (const child of node.children) {
    if (child.startIndex > lastIndex) {
      const whitespaceNode = {
        type: 'whitespace',
        text: source.substring(lastIndex, child.startIndex),
        children: [],
        parent: irNode
      };
      irNode.children.push(whitespaceNode);
    }

    const childIR = buildIR(child, source);
    childIR.parent = irNode;
    irNode.children.push(childIR);
    lastIndex = child.endIndex;
  }

  if (node.endIndex > lastIndex) {
    const trailingWhitespaceNode = {
      type: 'whitespace',
      text: source.substring(lastIndex, node.endIndex),
      children: [],
      parent: irNode
    };
    irNode.children.push(trailingWhitespaceNode);
  }

  return irNode;
}

function extractIdentifierName(node) {
  if (node.type === 'identifier') return node.text;
  for (const child of node.children) {
    const found = extractIdentifierName(child);
    if (found) return found;
  }
  return null;
}

function findStatementContainer(node) {
  let current = node;
  while (current && current.parent) {
    if (current.parent.type === 'compound_statement') {
      return { container: current.parent, statement: current };
    }
    current = current.parent;
  }
  return null;
}

function getIndentation(statementNode, compoundNode) {
  const index = compoundNode.children.indexOf(statementNode);
  if (index > 0 && compoundNode.children[index - 1].type === 'whitespace') {
    const wsText = compoundNode.children[index - 1].text;
    const lines = wsText.split('\n');
    return lines[lines.length - 1];
  }
  return '  ';
}

function transformAST(node, depth=0) {
  console.log(`${' '.repeat(depth)}${node.type} (${node.text.split('\n').join('\\n')})`);
  if (node.children) {
    [...node.children].forEach((childNode)=>transformAST(childNode, depth+1));
  }
  if (node.type === 'pointer_declarator') {
    const operatorChild = node.children.find(c => c.text === '*!' || c.text === '*?');
    if (operatorChild) {
      if (operatorChild.text === '*!') {
        if (!c42Opts.pointer?.nonNullSyntax) {
          throw new Error("Found '*!' syntax, but it is disabled in c42.json");
        }
        operatorChild.text = '*';
        const scopeContext = findStatementContainer(node);
        if (scopeContext) {
          const { container, statement } = scopeContext;
          const targetVar = extractIdentifierName(statement);
          
          if (targetVar) {
            const indent = getIndentation(statement, container);
            const stmtIndex = container.children.indexOf(statement);
            const assertionIR = {
              type: 'expression_statement',
              text: `\n${indent}assert(${targetVar} != NULL);`,
              children: [],
              parent: container
            };
            container.children.splice(stmtIndex + 1, 0, assertionIR);
          }
        }
      }
      if (operatorChild.text === '*?') {
        if (!c42Opts.pointer?.nullableSyntax) {
          throw new Error("Found '*?' syntax, but it is disabled in c42.json");
        }
        operatorChild.text = '*';
      }
    }
  }

}

function generateCode(node) {
  if (!node.children || node.children.length === 0) {
    return node.text;
  }
  return node.children.map(generateCode).join('');
}

module.exports = (tree, sourceCode) => {
  const irRoot = buildIR(tree.rootNode, sourceCode);
  transformAST(irRoot);
  const transformedCode = generateCode(irRoot);
  console.log(transformedCode);
};

/*
// node brain damage: (1) cant require a top level await (2) cant top level await with a require in the same file (3) import() on a directory doesnt work
import('./tree-sitter-c42/bindings/node/index.js').then((TreeSitterCESM)=>{
  const TreeSitterC = TreeSitterCESM.default;
*/
//});