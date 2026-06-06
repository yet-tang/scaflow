import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskContract,
  parseTaskSelection,
  slugifyTaskTitle,
  topologicalTaskOrder,
} from "./task-graph.mjs";

function contract(id, dependencies = [], definitionState = "ready") {
  return {
    id,
    title: id,
    dependencies,
    definitionState,
    source: `${id}/contract.yaml`,
  };
}

test("parses task metadata and dependencies", () => {
  const parsed = parseTaskContract(`version: 1
task:
  id: SFL-002
  title: Error and Logging Foundation
  definition_state: ready
dependencies:
  - SFL-001
dependency_changes: forbidden
`);
  assert.deepEqual(parsed, {
    id: "SFL-002",
    title: "Error and Logging Foundation",
    definitionState: "ready",
    dependencies: ["SFL-001"],
    source: "contract.yaml",
  });
});

test("parses an empty dependency list", () => {
  const parsed = parseTaskContract(`task:
  id: SFL-001
  title: Foundation
  definition_state: ready
dependencies: []
`);
  assert.deepEqual(parsed.dependencies, []);
});

test("parses sequential numeric and canonical task ranges", () => {
  assert.deepEqual(parseTaskSelection("2-6"), [
    "SFL-002",
    "SFL-003",
    "SFL-004",
    "SFL-005",
    "SFL-006",
  ]);
  assert.deepEqual(parseTaskSelection("SFL-002..SFL-004"), [
    "SFL-002",
    "SFL-003",
    "SFL-004",
  ]);
  assert.deepEqual(parseTaskSelection("SFL-006,SFL-002,4"), [
    "SFL-002",
    "SFL-004",
    "SFL-006",
  ]);
  assert.throws(() => parseTaskSelection("6-2"), /ascending/);
});

test("orders selected tasks by dependencies", () => {
  const contracts = [
    contract("SFL-003", ["SFL-001", "SFL-002"]),
    contract("SFL-001"),
    contract("SFL-002", ["SFL-001"]),
  ];
  assert.deepEqual(
    topologicalTaskOrder(contracts, ["SFL-003", "SFL-001", "SFL-002"]),
    ["SFL-001", "SFL-002", "SFL-003"],
  );
});

test("allows dependencies outside the selection when completed", () => {
  const contracts = [
    contract("SFL-001", [], "completed"),
    contract("SFL-002", ["SFL-001"]),
  ];
  assert.deepEqual(topologicalTaskOrder(contracts, ["SFL-002"]), ["SFL-002"]);
});

test("rejects incomplete dependencies outside the selection", () => {
  const contracts = [contract("SFL-001"), contract("SFL-002", ["SFL-001"])];
  assert.throws(
    () => topologicalTaskOrder(contracts, ["SFL-002"]),
    /SFL-001, which is not completed/,
  );
});

test("rejects cycles", () => {
  const contracts = [
    contract("SFL-001", ["SFL-002"]),
    contract("SFL-002", ["SFL-001"]),
  ];
  assert.throws(
    () => topologicalTaskOrder(contracts, ["SFL-001", "SFL-002"]),
    /cycle/,
  );
});

test("creates stable task branch slugs", () => {
  assert.equal(slugifyTaskTitle("Error & Logging Foundation"), "error-logging-foundation");
});
