# Spike C — companion and MariaDB vector

**Status: done. Go — the retrieval budget holds with an order of magnitude to spare, and
the one real risk turned out to be a server setting rather than the architecture.**
Task P0-T06. Brief: `docs/briefs/P0-T06.md`. Verified surface facts: `docs/SURFACE.md`.

## The question

ADR-05 puts the memory store in MariaDB with a vector index. ADR-17 designs the memory
kernel around one batched retrieval per turn on the assumption that a round trip is
expensive. `docs/LLM-PLAN.md` gives per-turn retrieval a **100 ms budget**. None of it had
been tested.

## What was built

| Piece | What it does |
|---|---|
| `companion/crates/server/migrations/0001_chunks.sql` | The real schema — `VECTOR(768)`, `VECTOR INDEX … M=8 DISTANCE=cosine`. **Not a spike copy**; P4 inherits a table that has been exercised |
| `companion/crates/server/src/vector.rs` | `&[f32]` ↔ little-endian bytes, with dimension and length refused before the wire |
| `companion/crates/server/src/db.rs` | Pool, migration, batched insert, top-k, `EXPLAIN`, and the synthetic fixture |
| `companion/crates/server/src/bench.rs` | The benchmark: `latentpresence-companion bench [rows]` |
| `.github/workflows/ci.yml` | A `mariadb:11.8.8` service container running the same schema and query, so the SQL is covered by the gate |

## The measurements

MariaDB **11.8.8** on `192.168.40.101` (LAN, 16 GB). Index `M=8 DISTANCE=cosine`,
`mhnsw_ef_search = 20`. Everything below is one uninterrupted run on an idle server,
200 queries per row count with 20 discarded as warm-up.

| | 10,000 rows | 100,000 rows |
|---|---|---|
| `SELECT 1` round trip, median | 0.31 ms | 0.42 ms |
| **top-8 query, median** | **1.42 ms** | **4.90 ms** |
| top-8 query, p95 | 2.79 ms | 8.47 ms |
| top-8 query, worst of 200 | 5.74 ms | 12.74 ms |
| query less round trip | 1.12 ms | 4.48 ms |
| `EXPLAIN` | `type=index key=embedding` | `type=index key=embedding` |

`EXPLAIN` names the index at both row counts, which is the check that matters: a query
whose distance function disagrees with the index falls back to a full scan silently, and a
fast wrong answer looks exactly like a fast right one until the table grows.

**Storage is bit-exact.** Every run writes an embedding, reads it back and compares
`to_bits()` per dimension before measuring anything. 768 dimensions in, 768 identical
dimensions out. The wire-format tests in `vector.rs` assert against recorded bytes but
never touch a server; this is the only check that MariaDB stores and returns the same 3072
bytes, and a storage-side surprise would corrupt every embedding while leaving all the
timings looking excellent.

## The finding: a 16 MB default was the whole problem

The first pass at this spike concluded that 100k rows was impractical — insert throughput
collapsed as the table grew, and an `ALTER TABLE … ADD VECTOR INDEX` on 100k rows was still
running after six minutes. That conclusion was wrong, and the cause was one setting.

768 float32 is 3072 bytes a row, so 100k rows is about **307 MB of vectors against a 16 MB
`mhnsw_max_cache_size`** — the stock default. Below the working-set size the index cache
thrashes and what you are timing is disk, not search. Rick raised `mhnsw_max_cache_size`
to 2 GiB and `innodb_buffer_pool_size` to 4 GiB and restarted. **Nothing else changed** —
same binary, same fixture, same 10,000 rows:

| | 16 MB cache | 2 GiB cache |
|---|---|---|
| top-8 median | 7.52 ms | **1.42 ms** |
| top-8 p95 | 9.20 ms | **2.79 ms** |
| insert throughput | 435 rows/s | **536 rows/s** |
| 100k rows | not reached | **reached in ~8 min** |

A fivefold latency difference bought with a setting rather than with code. Both readings
are honest; they measure different servers.

`mhnsw_max_cache_size` is **`GLOBAL`-only** — `SET GLOBAL` needs `SUPER`, which a
database-scoped application user does not have. It is an operator's setting, so it belongs
in deployment documentation and not in anything the product does at runtime. **Whatever
ships must document it**, because the default will silently make a user's memory store feel
broken and nothing in the product will be able to detect or fix it.

## What indexing costs on write

Two tables, 20,000 rows each, identical data, back to back on the idle server:

| | throughput | batch times across the run |
|---|---|---|
| **without** the vector index | 959 rows/s | 272, 463, 212, 210 ms — flat |
| **with** the vector index | 425 rows/s | 953, 846, 1166, 950 ms — flat |

**Indexing roughly halves write throughput and the cost stays flat.** That flatness is the
result. The earlier, confounded run showed batch times climbing 659 → 3,704 ms, which is
what an index-maintenance cost that grows without bound looks like; with a cache large
enough to hold the graph, it does not.

It is not entirely free at scale. Filling to 100k in one pass, sampled live:

| Table size | Insert rate |
|---|---|
| ~30k | 383 rows/s |
| ~42k | 250 rows/s |
| ~80k | 217 rows/s |
| ~96k | 167 rows/s |

A real curve, and a survivable one — 100k rows in about eight minutes. Ingest is a
background job in this product, never the speaking path, so a few hundred rows a second is
not a constraint on anything a person waits for.

## Does the 100 ms per-turn budget hold?

**On the LAN, yes, with about twelve times the headroom.** 8.47 ms p95 at 100k rows against
a 100 ms budget, worst-of-200 at 12.74 ms. Retrieval is not where a turn's time goes.

**Over a WAN it still holds, and ADR-17's one-call rule is why.** The tunnel host measured
**39.8 ms p50** for a bare `SELECT 1` (`docs/SURFACE.md`). Carrying the 100k server-side
work across it:

| | cost |
|---|---|
| One batched retrieval | 39.8 ms network + 4.5 ms work ≈ **44 ms** |
| Two statements | 79.6 ms network + work ≈ **86 ms** |
| Three statements | ≈ **128 ms** — over budget |

So the design rule in ADR-17 is confirmed with a number behind it: **one statement fits
comfortably, two are marginal, three miss.** "One batched retrieval call per turn" is a
requirement, not a precaution. Nothing in the spike suggests changing ADR-17 or ADR-05.

## What the latency buys: the `ef_search` trade

`mhnsw_ef_search` is **session-settable** — no `SUPER`, unlike the cache size — so an
application can choose this per query. Swept at 100k rows against exact top-8 ground truth,
20 probes, five repetitions (exact truth obtained with `+ 0` on the ordering expression,
which defeats the index and gives `type=ALL`; a full scan costs **247 ms** against the
index's single-digit milliseconds):

| `ef_search` | median | p95 | mean distance | gap vs exact | true top-8 found |
|---|---|---|---|---|---|
| 10 | 1 ms | 7 ms | 0.912813 | +0.0575 | 0.0 / 8 |
| **20** (default) | 1 ms | 4 ms | 0.905437 | +0.0501 | 0.1 / 8 |
| 40 | 1 ms | 6 ms | 0.897481 | +0.0422 | 0.1 / 8 |
| 80 | 1 ms | 8 ms | 0.890181 | +0.0349 | 0.2 / 8 |
| 160 | 2 ms | 10 ms | 0.882433 | +0.0271 | 0.3 / 8 |
| 320 | 3 ms | 12 ms | 0.876614 | +0.0213 | 0.8 / 8 |

Exact mean distance: **0.855314**. (Latencies here are millisecond-resolution from a Node
probe, coarser than the Rust benchmark's timings above; the shape is the point, not the
digits.)

**The trade is real and it is monotone**: every increase in `ef_search` buys a closer set of
neighbours and costs latency. The important number is the last row — **at `ef_search` 320,
p95 is 12 ms against a 100 ms budget.** There is enough headroom to buy a great deal of
recall if P4 finds it needs to, and that is the reassuring result: retrieval quality is a
dial this product can afford to turn, not a fixed constraint.

## What this spike cannot tell you

**Recall, in any number worth quoting.** The "true top-8 found" column above looks alarming
— 0.1 of 8 at the default — and it is not the disaster it appears to be, but neither is it
a tie. Both readings need care, so here is the honest version.

The fixture is 768-dimensional pseudo-random unit vectors, and in 768 dimensions random
unit vectors are all nearly orthogonal. Over 2,000 of them the cosine distances to a probe
had **mean 1.0009, standard deviation 0.036**. Against that spread:

- exact top-8 sits about **4.0 standard deviations** below the population mean;
- the index at default `ef_search` returns items about **2.65 standard deviations** below,
  which is roughly **the best 0.4%** of 100,000 rows.

So the index is not returning noise — it lands in a genuinely good neighbourhood — but it
is really missing the true nearest neighbours, not merely picking between ties. An earlier
draft of this document called them ties; that was too generous to the index, and the
standard-deviation arithmetic is what corrects it.

**But this fixture is close to the worst case any approximate index will ever see.** A
graph index works by descending through cluster structure, and uniformly random vectors
have none for it to exploit. Real embeddings cluster hard — a true nearest neighbour stands
out from the crowd rather than hiding among a hundred thousand near-equidistant strangers.
So these figures are a **floor**, not an estimate, and quoting "0.1 of 8" as MHNSW's recall
would be a statement about my fixture rather than about MariaDB.

**Recall belongs to P4**, measured against real embeddings from the model the product
actually uses, with this table as the shape of the dial rather than the value on it.

What the fixture is good for is latency and throughput, which is what it was used for. It
is deterministic (SplitMix64 per dimension), so a second run measures the same data — and
it is hashed rather than smooth for a reason recorded in `db.rs`: the first version used
`sin(seed·k + i·k₂)`, sine is periodic, and two seeds a fixed distance apart produced
vectors at **distance 0.000000** from each other. Colliding probes are the easiest possible
query for a nearest-neighbour index, and that fixture was one commit away from flattering
every number in this document.

## Honesty notes

- An earlier set of 100k figures was taken while the server's own update agent was
  installing packages including a kernel. **None of those numbers appear here.** Everything
  above was re-measured on an idle box after that agent was moved off it.
- `mhnsw_ef_search` was 20 — the default — for every latency in the measurements table. A
  fast number at a low `ef_search` is a fast number for a worse answer, so the setting is
  reported beside the figures rather than left implicit, and swept above so the shape of
  the trade is visible rather than assumed.
- CI's `vector` job proves the schema, the encoding and the index against a real MariaDB in
  seconds. **It is not this measurement** and does not pretend to be: it runs two thousand
  rows on shared runner hardware over loopback. What it catches is the schema breaking.
- Cleanup: the benchmark truncates `chunks` before and after each run, and every
  experiment table was dropped. The orphaned `spike_c_100k` left by the confounded run —
  390 MB — is gone.

## Verdict

**Go.** MariaDB 11.8.8 stores 768-dimensional vectors bit-exactly, indexes them, uses the
index, and answers a top-8 query at 100k rows in 4.90 ms median and 8.47 ms p95 on the LAN.
The 100 ms per-turn budget holds on the LAN with room to spare, and over a WAN provided
retrieval stays a single statement — which ADR-17 already requires.

The one thing to carry forward is not an architecture change, it is a deployment note:
**`mhnsw_max_cache_size` must be sized to the vector working set, or the store will feel
broken for reasons the product cannot detect or fix.**
