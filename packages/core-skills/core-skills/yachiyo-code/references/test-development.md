# Test Development

Tests are a tool for confidence, not a ritual for coverage. A test suite that gives false confidence is worse than no tests.

## What to Test

- **Behavior at the boundary** of the unit: inputs in, outputs and effects out.
- **Edge cases**: empty, null, max size, off-by-one, unicode, negative numbers, concurrent access.
- **Bug regressions**: every fixed bug should have a test that would have caught it.
- **Integration seams**: the places where your code meets a library, network, filesystem, database.
- **User-visible contracts**: anything documented or relied on externally.

## What Not to Test

- **Implementation details** (private methods, internal state). They change; behavior shouldn't.
- **Framework or library code.** You're not testing React or Express.
- **Trivial getters/setters** with no logic.
- **Generated code.**
- **Things that can only fail if the language itself is broken.**

## The Test Pyramid (Still True)

- **Many** unit tests — fast, isolated, run on every save.
- **Some** integration tests — verify your code works against real adjacent systems (real DB, real HTTP).
- **Few** end-to-end tests — slow, brittle, but the only thing that proves the whole product works.

If your suite is mostly E2E, every change becomes a 20-minute ordeal. If it's only unit tests, broken integrations slip through. Balance.

## Anatomy of a Good Test

Whatever the framework — `pytest`, `go test`, `cargo test`, JUnit, RSpec, Jest, `node:test`, xUnit — the shape is the same:

```
test "descriptive name of behavior":
    # Arrange — set up inputs and state
    input = ...

    # Act — call the thing
    result = do_the_thing(input)

    # Assert — verify the outcome
    assert result == expected
```

- One behavior per test. If you need multiple unrelated assertions, split it.
- The test name should describe the behavior, not the function: `returns empty list when input is empty`, not `test_do_the_thing_2`.
- Avoid logic in tests (no loops, no conditionals). If a test needs a loop, you probably want multiple tests or table-driven tests (`pytest.mark.parametrize`, Go's table tests, JUnit's `@ParameterizedTest`).

## Mocking Discipline

Mocks are a sharp tool. Overuse and your tests stop testing reality.

- **Don't mock what you don't own.** Mocking your own modules is fine; mocking the database driver or HTTP client itself is asking for false confidence.
- **Prefer fakes/stubs over mocks** when you can. A real in-memory implementation (in-memory SQLite, an embedded Redis, a fake clock) tests more behavior than a mock that returns a fixed value.
- **Never mock the thing under test.** That's a tautology.
- **If you mock the database in a test that's supposed to verify a query, the test is meaningless.**

## Flaky Tests

A flaky test is a broken test. Don't retry, don't `skip`, don't ignore. Diagnose:

- Race condition? → fix the synchronization.
- Time-dependent? → inject a clock.
- Order-dependent? → fix the test setup/teardown.
- Network-dependent? → mock at the network boundary or use a fixture server.

A flaky test that everyone re-runs is worse than no test — it trains the team to ignore real failures.

## Test Performance

- Unit tests under 10ms each. Integration tests under 1s. E2E whatever-it-takes but few in number.
- Run only the relevant subset during development. Save the full suite for CI or pre-merge.
- If the full suite takes more than a few minutes, that's a problem worth fixing — slow tests get skipped.

## TDD When It Helps

Test-first works well when:

- The behavior is well-specified before you start.
- You're fixing a reproducible bug (write the failing test, then fix).
- You're working on a pure function or a deterministic algorithm with clear inputs and outputs.

It works less well when:

- You're exploring a design — write a spike, then tests for what you keep.
- You're working on UI / visual things — eyeballs are a faster feedback loop than asserts.

Don't let TDD-as-religion stop you from sketching. Don't let "I'll add tests later" stop you from ever testing.

## Anti-Patterns

- **Asserting on internal state.** Test the output, not the variables.
- **Tests that pass whether the code is right or wrong.** (Run the test against deliberately broken code — does it fail? If not, it's a no-op.)
- **Coverage chasing.** 100% coverage of useless tests is worse than 60% coverage of meaningful ones.
- **One mega-test that exercises everything.** When it fails you learn nothing about which part broke.
- **Test names like `test1`, `test_works`, `it should work`.** Future you will hate present you.
