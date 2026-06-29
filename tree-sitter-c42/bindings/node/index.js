const fs = require("node:fs");
const path = require("node:path");

// Calculate the root directory using standard CommonJS __dirname
const root = path.resolve(__dirname, "../..");

// Synchronously load the native binding binary based on the runtime engine
const binding = typeof process.versions.bun === "string"
  ? require(`${root}/prebuilds/${process.platform}-${process.arch}/tree-sitter-c.node`)
  : require("node-gyp-build")(root);

// Synchronously load the node types structure
try {
  const nodeTypes = require(`${root}/src/node-types.json`);
  binding.nodeTypeInfo = nodeTypes;
  binding.nodeTypeNamesById = nodeTypes.map(type => type.type || type);
} catch { }

const queries = [
  ["HIGHLIGHTS_QUERY", `${root}/queries/highlights.scm`],
  ["INJECTIONS_QUERY", `${root}/queries/injections.scm`],
  ["LOCALS_QUERY", `${root}/queries/locals.scm`],
  ["TAGS_QUERY", `${root}/queries/tags.scm`],
];

for (const [prop, pathString] of queries) {
  Object.defineProperty(binding, prop, {
    configurable: true,
    enumerable: true,
    get() {
      delete binding[prop];
      try {
        binding[prop] = fs.readFileSync(pathString, "utf8");
      } catch { }
      return binding[prop];
    }
  });
}

// Export the raw native C++ object directly
module.exports = binding;