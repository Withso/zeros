# Test every shared fixture consumer

Replacing a portable process reader bypassed two cleanup tests' native-reader
mock. Sixteen adjacent suites passed, but the indirect consumer no longer
exercised either an incomplete census or a persistent observation failure.

The portable fixture now accepts an explicit census observer, passed through
its legacy boot helper. The cleanup tests inject failures on that seam and
retain both bounded recovery and refusal when positive proof stays unavailable.
The ci-red playbook requires every direct and transitive helper importer before
READY; the portable-census-consumer-faults replay retains the escaped regression.
