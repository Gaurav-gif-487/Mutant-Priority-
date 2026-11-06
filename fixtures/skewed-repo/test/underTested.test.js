const test = require("node:test");
const assert = require("node:assert");
const { gate } = require("../src/underTested");
// only ever calls gate with flag=true; never exercises the false path,
// and never checks a value where mutating the boolean-literal comparison
// would flip the observable result in this one test.
test("gate doubles when true", () => assert.strictEqual(gate(true, 5), 10));
