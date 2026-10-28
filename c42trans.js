#!/usr/bin/env node
'use strict';
// node c42trans.js test.c -o test.c11

const fs = require('fs');
const path = require('path');
const Parser = require('tree-sitter');
const TreeSitterC42 = require('./tree-sitter-c42');

const {argv, c42Opts} = require('./src/opts');

const parser = new Parser();
parser.setLanguage(TreeSitterC42);
const source = fs.readFileSync(argv.input_file, 'utf8');
const tree = parser.parse(source);

const ir = require('./src/ir');
const document = ir.Document.fromTreeSitter(tree, source);
//fs.writeFileSync('test.ast', JSON.stringify(document.toJson(), null, 2));
fs.writeFileSync('test.ast', document.root.toDebugOutline());
const irDemo = require('./src/ir-demo');
irDemo(document, source);

const pg = require('./src/promise-graph');
const graph = pg.extractPromiseGraph(document, c42Opts.visualization);
fs.writeFileSync('test.json', JSON.stringify(graph, null, 2));
fs.writeFileSync('test.dot', pg.renderPromiseGraphDot(graph));

const { transpileDocument } = require('./src/transpile');
const transpiled = transpileDocument(document, c42Opts);
fs.writeFileSync(argv.o, transpiled);
