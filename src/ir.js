'use strict';

// ---------------------------------------------------------------------------
// IrNode — a mutable DOM-style tree node built from a tree-sitter node.
// ---------------------------------------------------------------------------

class IrNode {
  constructor({ type, text = null, start = null, end = null, synthetic = false }) {
    this.type = type;               // e.g. 'function_definition', 'whitespace', 'text'
    this.text = text;               // leaf text (null for branch nodes)
    this.start = start;             // original byte offset in source (null if synthetic)
    this.end = end;                 // original byte end offset
    this.synthetic = synthetic;     // true if injected by a transform pass
    this.children = [];             // IrNode[]
    this.parent = null;             // set when child is appended
    this.fields = {};               // named fields, mirrors tree-sitter childForFieldName
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild, referenceChild) {
    const i = this.children.indexOf(referenceChild);
    if (i === -1) throw new Error('insertBefore: referenceChild not found');
    newChild.parent = this;
    this.children.splice(i, 0, newChild);
    return newChild;
  }

  insertAfter(newChild, referenceChild) {
    const i = this.children.indexOf(referenceChild);
    if (i === -1) throw new Error('insertAfter: referenceChild not found');
    newChild.parent = this;
    this.children.splice(i + 1, 0, newChild);
    return newChild;
  }

  replaceChild(newChild, oldChild) {
    const i = this.children.indexOf(oldChild);
    if (i === -1) throw new Error('replaceChild: oldChild not found');
    newChild.parent = this;
    oldChild.parent = null;
    this.children[i] = newChild;
    return oldChild;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i === -1) throw new Error('removeChild: child not found');
    child.parent = null;
    this.children.splice(i, 1);
    return child;
  }

  remove() {
    if (this.parent) this.parent.removeChild(this);
  }

  // Replace this node in its parent with one or more nodes.
  replaceWith(...nodes) {
    if (!this.parent) throw new Error('replaceWith: node has no parent');
    const i = this.parent.children.indexOf(this);
    this.parent.children.splice(i, 1, ...nodes);
    nodes.forEach(n => { n.parent = this.parent; });
    this.parent = null;
  }

  // -------------------------------------------------------------------------
  // DOM-style query
  // -------------------------------------------------------------------------

  // Depth-first, returns all descendants (and self) matching predicate.
  querySelectorAll(predicate) {
    const results = [];
    this._walk(node => { if (predicate(node)) results.push(node); });
    return results;
  }

  // First descendant matching predicate.
  querySelector(predicate) {
    let found = null;
    this._walkUntil(node => {
      if (predicate(node)) { found = node; return true; }
      return false;
    });
    return found;
  }

  // All descendants (and self) with a given type — analogous to
  // document.getElementsByTagName.  Type may be a string or array of strings.
  getElementsByType(type) {
    const types = Array.isArray(type) ? type : [type];
    return this.querySelectorAll(n => types.includes(n.type));
  }

  // Nearest ancestor with a given type (not including self).
  closest(type) {
    const types = Array.isArray(type) ? type : [type];
    let n = this.parent;
    while (n) {
      if (types.includes(n.type)) return n;
      n = n.parent;
    }
    return null;
  }

  // Named field child (mirrors tree-sitter childForFieldName).
  field(name) {
    return this.fields[name] || null;
  }

  // Named children (leaf text, convenience).
  get textContent() {
    if (this.text !== null) return this.text;
    return this.children.map(c => c.textContent).join('');
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  serialize() {
    // Leaf node — just emit text.
    if (this.text !== null) return this.text;
    return this.children.map(c => c.serialize()).join('');
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  _walk(fn) {
    fn(this);
    for (const child of this.children) child._walk(fn);
  }

  _walkUntil(fn) {
    if (fn(this)) return true;
    for (const child of this.children) {
      if (child._walkUntil(fn)) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory helpers for synthetic nodes
// ---------------------------------------------------------------------------

function textNode(text) {
  return new IrNode({ type: 'text', text, synthetic: true });
}

function whitespaceNode(text) {
  return new IrNode({ type: 'whitespace', text, synthetic: true });
}

function branchNode(type, children = []) {
  const node = new IrNode({ type, synthetic: true });
  for (const child of children) node.appendChild(child);
  return node;
}

// ---------------------------------------------------------------------------
// Build IR from tree-sitter tree
// ---------------------------------------------------------------------------

// tree-sitter exposes named and unnamed (anonymous) children.
// Named children are grammar-significant; unnamed are punctuation/whitespace.
// We include all children so whitespace is preserved.

function irNodeFromTreeSitter(tsNode, source) {
  // Get all tree-sitter children (does NOT include extras like whitespace/comments)
  const kids = [];
  for (let i = 0; i < tsNode.childCount; i++) {
    kids.push(tsNode.child(i));
  }

  const isLeaf = kids.length === 0;

  const ir = new IrNode({
    type: tsNode.type,
    // For leaf nodes, store the text directly from source
    text: isLeaf ? source.slice(tsNode.startIndex, tsNode.endIndex) : null,
    start: tsNode.startIndex,
    end: tsNode.endIndex,
    synthetic: false,
  });

  // For non-leaf nodes, walk through the byte range and insert
  // "extra" nodes for any gaps between children (whitespace, comments)
  if (!isLeaf) {
    let pos = tsNode.startIndex;

    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];

      // Capture any extras before this child
      if (pos < child.startIndex) {
        const extraNode = new IrNode({
          type: 'extra',
          text: source.slice(pos, child.startIndex),
          start: pos,
          end: child.startIndex,
          synthetic: false,
        });
        ir.appendChild(extraNode);
      }

      // Recursively convert the child
      const childIr = irNodeFromTreeSitter(child, source);
      ir.appendChild(childIr);

      // Set field name if applicable
      if (tsNode.fieldNameForChild) {
        const fname = tsNode.fieldNameForChild(i);
        if (fname) {
          if (ir.fields[fname]) {
            if (!Array.isArray(ir.fields[fname])) ir.fields[fname] = [ir.fields[fname]];
            ir.fields[fname].push(childIr);
          } else {
            ir.fields[fname] = childIr;
          }
        }
      }

      pos = child.endIndex;
    }

    // Capture any trailing extras after the last child
    if (pos < tsNode.endIndex) {
      const extraNode = new IrNode({
        type: 'extra',
        text: source.slice(pos, tsNode.endIndex),
        start: pos,
        end: tsNode.endIndex,
        synthetic: false,
      });
      ir.appendChild(extraNode);
    }
  }

  return ir;
}

// tree-sitter node.childForFieldName returns the first child with that field
// name but doesn't tell us which index.  We probe all known field names.
// This is O(fields * children) but only runs once at IR-build time.
function buildFieldNameMap(tsNode) {
  const map = {}; // childIndex -> fieldName
  // Collect field names by checking each named child.
  for (let i = 0; i < tsNode.childCount; i++) {
    const child = tsNode.child(i);
    // tree-sitter >= 0.20 exposes node.fieldNameForChild(i)
    if (tsNode.fieldNameForChild) {
      const fname = tsNode.fieldNameForChild(i);
      if (fname) map[i] = fname;
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Document — the root container, analogous to the browser Document object.
// ---------------------------------------------------------------------------

class Document {
  constructor(root) {
    this.root = root; // IrNode for translation_unit
  }

  // All nodes of a given type anywhere in the tree.
  // Analogous to document.getElementsByTagName.
  getElementsByType(type) {
    return this.root.getElementsByType(type);
  }

  // Convenience: all function_definition nodes.
  getFunctions() {
    return this.getElementsByType('function_definition');
  }

  // Convenience: all async function_definition nodes (have 'async' type_qualifier).
  getAsyncFunctions() {
    return this.getFunctions().filter(fn =>
      fn.querySelectorAll(n => n.type === 'type_qualifier' && n.textContent.trim() === 'async').length > 0
    );
  }

  // Serialize the whole document back to source.
  serialize() {
    return this.root.serialize();
  }

  // Build a Document from a tree-sitter tree + source string.
  static fromTreeSitter(tree, source) {
    const root = irNodeFromTreeSitter(tree.rootNode, source);
    return new Document(root);
  }
}

module.exports = { IrNode, Document, textNode, whitespaceNode, branchNode, irNodeFromTreeSitter };