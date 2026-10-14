Resume's three-minute deadline omitted the setup attempt/claim, and cleanup
could overwrite the first failure. Enrich existing status observations with a
closed current-generation projection, name each lifecycle wait, and preserve
the work failure separately from cleanup without extending any deadline.
Product/CLI/receipt regressions cover the deadline, stale and unknown fields,
older-server compatibility, and simultaneous resume/cleanup failures.
