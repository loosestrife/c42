"use strict";

module.exports = function demoIr(doc, source) {
  // getElementsByType — like getElementsByTagName
  const functions = doc.getElementsByType("function_definition");
  console.log(`\n=== ${functions.length} function definitions ===`);
  for (const fn of functions) {
    const decl = fn.field("declarator");
    // declarator is a function_declarator; its first child is the identifier
    const nameNode = decl && decl.children.find((c) => c.type === "identifier");
    const isAsync = fn.querySelector(
      (n) => n.type === "type_qualifier" && n.textContent.trim() === "async",
    );
    console.log(
      `  ${isAsync ? "async " : ""}${nameNode ? nameNode.textContent : "?"}`,
    );
  }

  // getAsyncFunctions convenience method
  const asyncFns = doc.getAsyncFunctions();
  console.log(`\n=== ${asyncFns.length} async functions ===`);
  for (const fn of asyncFns) {
    // Find all _context declarations inside
    const contextDecls = fn
      .getElementsByType("declaration")
      .filter((d) =>
        d.children.some(
          (c) =>
            c.type === "storage_class_specifier" &&
            c.textContent.trim() === "_context",
        ),
      );
    const decl = fn.field("declarator");
    const nameNode = decl && decl.children.find((c) => c.type === "identifier");
    console.log(
      `  ${nameNode ? nameNode.textContent : "?"}: ${contextDecls.length} _context vars`,
    );
    for (const cd of contextDecls) {
      // find the identifier
      const decl = cd.querySelector(
        (n) =>
          n.type === "identifier" &&
          n.closest("declaration") === cd &&
          !n.closest("macro_type_specifier"),
      );
      console.log(`    _context: ${decl ? decl.textContent : "?"}`);
    }
  }

  // Demo mutation: find the first closure_expression and show its textContent
  const closures = doc.getElementsByType("closure_expression");
  console.log(`\n=== ${closures.length} closure expressions ===`);
  for (const cl of closures) {
    const name = cl.field("name");
    const enclosingFn = cl.closest("function_definition");
    const enclosingDecl = enclosingFn && enclosingFn.field("declarator");
    const enclosingName =
      enclosingDecl &&
      enclosingDecl.children.find((c) => c.type === "identifier");
    console.log(
      `  ^${name ? name.textContent : "(unnamed)"} in ${enclosingName ? enclosingName.textContent : "?"}`,
    );
  }

  // Demo: serialize round-trips cleanly (output === input)
  const serialized = doc.serialize();
  const roundTripOk = serialized === source;
  console.log(
    `\n=== serialize round-trip: ${roundTripOk ? "OK" : "MISMATCH"} ===`,
  );
  if (!roundTripOk) {
    // Find first difference
    for (let i = 0; i < Math.max(serialized.length, source.length); i++) {
      if (serialized[i] !== source[i]) {
        console.log(
          `  first diff at byte ${i}: got ${JSON.stringify(serialized.slice(i, i + 20))} expected ${JSON.stringify(source.slice(i, i + 20))}`,
        );
        break;
      }
    }
  }

  return doc;
};
