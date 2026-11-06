const test = require("node:test");
const assert = require("node:assert");
// this is the ajv-shaped pattern: the test suite imports the package
// by its OWN NAME, like an external consumer would, not by relative path.
const { greet } = require("mylib");
test("greet", () => assert.strictEqual(greet("Sam"), "hi Sam"));
