# Portable partitioning

Status: **DEFERRED. Design not started.**

**This is a record of measured facts, not a design.** The grammar question is open and
will be discussed deliberately. Nothing here proposes a shape, and nothing here should be
implemented from.

## The goal, as stated

**Partitioning must work on every vendor.** The DSL is a high-level language that compiles
to vendor SQL; a target's quirks are a lowering problem, not a capability limit.

## What is measured

At `e10b031b`.

**The IR's partition vocabulary is PostgreSQL transcribed.**
`zero-migrate-ir/src/ir.rs:1990` — every doc comment is PostgreSQL syntax verbatim:

```
  PartitionBounds::Range { from, to }            /// FOR VALUES FROM (...) TO (...)
  PartitionBounds::List  { values }              /// FOR VALUES IN (...)
  PartitionBounds::Hash  { modulus, remainder }  /// FOR VALUES WITH (MODULUS m, REMAINDER r)
  PartitionBounds::Default                       /// DEFAULT
```

**The engine emits no MySQL partition DDL.** VERIFIED: the only table-partitioning
`PARTITION BY` in the tree is `declarative.rs:1712`, which calls `render_ident_list_pg`.
Every other occurrence is `ROW_NUMBER() OVER (PARTITION BY ...)`, a window function in
journal queries. MySQL's native partitioning is entirely unused.

**The declared disposition does not match the sidecar's own definition of the token.**
`dialect-support.toml` declares `createPartition/base` as `pg = portable`,
`sqlite = transparentDegradable`, `mysql = transparentDegradable`. The legend defines
`transparentDegradable` as *"native where supported, absence-tolerable elsewhere"* — the
degradation is licensed by ABSENCE. On SQLite the feature is genuinely absent, so the
collapse is correct there. On MySQL the feature is present and the engine degrades anyway.

**The four PostgreSQL gates in `render/lower.rs` are not uniform:**

```
  5320  createPartition    not-pg -> collapse path   (synthesized)
  5378  attachPartition    not-pg -> UnsupportedOp   (refused)
  5392  detachPartition    not-pg -> UnsupportedOp   (refused)
  5406  dropPartition      not-pg -> collapse        (synthesized)
```

Two synthesize, two refuse. The group is already inconsistent with itself.

## The three object models, for whenever the design discussion happens

```
  PostgreSQL   parent + CHILD RELATIONS. children are addressable tables;
               ATTACH / DETACH move them in and out.

  MySQL        ONE table, INTERNAL named segments.
               ADD / DROP / REORGANIZE / TRUNCATE PARTITION.
               EXCHANGE PARTITION swaps a segment with a standalone table.

  SQLite       none. the collapse is the only honest lowering.
```

Partitions are NAMED in both PostgreSQL and MySQL.

## Where the current vocabulary has no MySQL expression

Stated as facts about the databases, not as an argument for any particular fix.

```
  Range{from,to}    MySQL has VALUES LESS THAN only: upper bound, ascending,
                    implicitly contiguous. A range set WITH GAPS has no MySQL form.

  List{values}      maps directly.

  Hash{mod,rem}     MySQL declares a COUNT (PARTITIONS n), not per-partition
                    remainders. An INCOMPLETE hash cover has no MySQL form.

  Default           MySQL RANGE has MAXVALUE; MySQL LIST has no default at all.
                    Default under a list has no MySQL form.
```

## Two things to verify before any design discussion

Both are reasoned from knowledge and **NOT measured** against the live MySQL 8.4.11 this
repo gates against. Either could change the shape of the problem.

- **Does `ALTER TABLE ... ADD PARTITION` require the table to have been created
  `PARTITION BY`?** If yes, converting a plain table is a full rebuild, and
  `createPartition` on an unpartitioned MySQL table is a very different operation from an
  add. That changes the cost materially.
- **Exactly which unique-key restrictions bite on each database.** Both are believed to
  require every unique key to contain the partition columns, but the details may differ.
  If they agree, it is enforceable offline at author time on every dialect.

## One constraint that cannot be lowered away

MySQL/InnoDB forbids foreign keys on partitioned tables outright. PostgreSQL allows them.
No amount of clever lowering removes this; it is a genuine capability difference and will
have to be faced directly by whatever design is chosen.

## Related

- `docs/open-decisions.md` decision 5 asks a narrower question — where the four
  PostgreSQL gates should live. That is separable from this and can be settled first: the
  `Capability` enum's own doc says a predicate only one backend has should stay PRIVATE to
  its own rendering rather than become a shared capability.
- Decision 4 in the same file is the same shape at a different seam: the database can do
  the thing, the engine does not lower to it, and the capability table describes the
  shortfall as though it were a property of the database.
