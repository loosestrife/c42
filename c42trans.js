#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Parser = require('tree-sitter');
const TreeSitterC42 = require('./tree-sitter-c42');

const {argv, c42Opts} = require('./src/opts');

const parser = new Parser();
parser.setLanguage(TreeSitterC42);
const source = fs.readFileSync(argv.input_file, 'utf8');
const tree = parser.parse(source);
const root = tree.rootNode;

const ir = require('./src/ir');
const document = ir.Document.fromTreeSitter(tree, source);
const irDemo = require('./src/ir-demo');
irDemo(document, source);



/*
require('./src/print-ast')(tree, source);
const ops = require('./src/ast-transform');
const {forEachNode, applyEdits} = require('./src/util');
const {hoistClosures} = require('./src/hoist-closures');

forEachNode(root, ops.extractAsyncFunctionMetadata);

{
  const {hoisted, edits} = hoistClosures(root, source);
  console.log(applyEdits(source, hoisted, edits));
  fs.writeFileSync(argv.o, applyEdits(source, hoisted, edits));
}
*/