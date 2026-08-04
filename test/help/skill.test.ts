import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leafPaths, program } from './tree';

/**
 * The `skills/pingcode/` contract, rewritten by F1 per PRD R6.
 *
 * **What changed, and why.** The old suite asserted the SKILL.md ↔ CLI relationship
 * in *both* directions. The reverse direction — every leaf command must appear
 * somewhere in SKILL.md — is deleted here. At 55 leaves it was merely strict; at the
 * ~150 leaves this task is heading for it becomes a mandate for a 3000-line document
 * and, worse, a file every parallel child must edit in the same place. That is the
 * definition of a merge point (design D6.4).
 *
 * **What is kept.** The forward direction: every `pingcode …` path the docs mention
 * must resolve in the commander tree. That is the assertion that actually protects
 * the user, because a documented command that does not exist sends an agent into a
 * retry loop. It now runs over SKILL.md **and** every `modules/*.md`, so a reserved
 * module file cannot smuggle in a command that has not been built yet.
 *
 * **What replaces the reverse direction.** Six content classes that must be present
 * however large the surface gets — the auth gate, the `--json` contract, the
 * `--dry-run` contract, the exit-code table, the per-module document map, and an
 * explicit `REQUIRED_FLOWS` allowlist. The allowlist is the deliberate part: adding a
 * refined flow to the docs is one row here, chosen by a human, rather than something
 * a grep forces on every child (PRD R6).
 */

const skillDir = fileURLToPath(new URL('../../skills/pingcode', import.meta.url));

function read(relativePath: string): string {
  return readFileSync(`${skillDir}/${relativePath}`, 'utf8');
}

const skill = read('SKILL.md');

const moduleFiles = readdirSync(`${skillDir}/modules`)
  .filter((name) => name.endsWith('.md'))
  .sort();

const modules = Object.fromEntries(
  moduleFiles.map((name) => [name, read(`modules/${name}`)] as const),
);

/** Everything an agent reads, for the assertions that do not care which file. */
const allDocs = [skill, ...Object.values(modules)].join('\n');

/**
 * The refined flows the docs must describe, by name and by a pattern that proves the
 * description is actually there.
 *
 * **Add a row when you add a flow.** That is the point: it is an explicit, reviewable
 * act. Do not replace this with a traversal of the command tree — that would
 * reintroduce the exhaustive reverse assertion this file exists to remove.
 *
 * F3/F4/S1–S4 add their rows here as they land (`api`, `resolve`, `scm`, `build`,
 * `release`, the crosscutting subgroups). `api` landed with F3; the rest are absent
 * because those commands are absent, and documenting a command that does not exist is
 * the one failure mode the forward assertion below is designed to catch.
 */
const REQUIRED_FLOWS: readonly (readonly [string, RegExp])[] = [
  ['auth', /pingcode auth status/],
  // F3 — the generic escape hatch. Three rows, because the executor is useless to an
  // agent without the two discovery commands that tell it which path to hand over.
  ['generic executor', /pingcode api (GET|POST|PATCH|PUT|DELETE) \/v1\//],
  ['generic executor discovery', /pingcode api list --(search|module|token|method) /],
  ['generic executor describe', /pingcode api describe /],
  ['generic executor contract', /`?--json`? is a no-op on the five verbs/],
  // F4 — the other half of the generic layer: `api` takes ids only, so the docs have to
  // say where an id comes from. Two rows, for the lookup and for its discovery command.
  ['name resolution', /pingcode resolve (project|ship-product|testhub-library|ship-idea-state) /],
  ['name resolution discovery', /pingcode resolve list/],
  ['work items', /pingcode project work-item (get|create|update)/],
  ['work-item state transition', /pingcode project work-item transition/],
  ['project id lookups', /pingcode project meta (types|states|priorities|sprints)/],
  ['requirements', /pingcode product idea (list|get|create|update)/],
  ['tickets', /pingcode product ticket (list|get|create|update|transition)/],
  ['product id lookups', /pingcode product meta /],
  ['test libraries', /pingcode testhub libraries (list|get|create)/],
  ['test cases', /pingcode testhub cases (list|get|create|update)/],
  ['test plans', /pingcode testhub plans (list|get|create)/],
  ['runs', /pingcode testhub runs (list|patch|bulk)/],
  ['testhub id lookups', /pingcode testhub meta /],
  ['organisation members', /pingcode settings users/],
  // F5 — the four cross-object families. Five rows, because each family has a trap that
  // is invisible from `--help` alone and an agent that does not know it will loop:
  // a relation needs a target *kind* and refuses same-kind work-item pairs, a comment
  // delete does not delete, an attachment can only be a snippet and only under a
  // comment, and an activity feed is the only change stream this API has.
  ['cross-object comments', /pingcode project work-item comment (add|list|get|delete)/],
  ['cross-object relations', /pingcode (product idea|testhub cases) relation (add|list)/],
  ['cross-object attachments', /pingcode project work-item attachment add-snippet/],
  ['cross-object activities', /pingcode testhub runs activity list/],
  ['no top-level comment group', /no top-level `?comment`? group/i],
  // S1a — the scm foundation. Three rows: the platform hop every other scm command
  // starts from, the git identity commit attribution matches by name, and the
  // repository whose unique key is the full_name rather than the name.
  ['scm platforms', /pingcode scm platform (list|get|create|update)/],
  ['scm git identities', /pingcode scm platform-user (list|get|create|update)/],
  ['scm repositories', /pingcode scm repo (list|get|create|update)/],
  // S1b — the CI write-back path. Four rows: the three resources, plus one for the
  // delete, because it is the module's only destructive verb and the thing an agent
  // most needs warned about (it orphans refs and cannot touch the default branch).
  ['scm branches', /pingcode scm branch (list|get|create|update)/],
  ['scm branch deletion', /pingcode scm branch delete .*--yes/],
  ['scm commits', /pingcode scm commit (list|get|create)/],
  ['scm commit refs', /pingcode scm ref (list|get|create)/],
  // S1c — the last two scm families. Three rows: the two resources, plus one for the
  // `/v1/reviews` disambiguation, because an agent that conflates the two will hand a
  // `scm review` id to `pingcode api GET /v1/reviews/{id}` and get a not-found it cannot
  // explain.
  ['scm pull requests', /pingcode scm pr (list|get|create|update)/],
  ['scm code reviews', /pingcode scm review (list|get|create|update)/],
  ['scm review is not /v1\/reviews', /`?scm review`? is not `?pingcode api . \/v1\/reviews`?/i],
  // S1d — the last two DevOps groups. Five rows, because four of the five things an agent
  // gets wrong here are *absences* it cannot see in `--help` alone: `build list` has no
  // filters at all, a build number is not a key, `release deploy list` hides an unknown
  // environment behind an empty list, and the two DELETEs exist upstream but are only
  // reachable through the generic layer. The fifth is the one link both groups have.
  ['build records', /pingcode build (list|get|create|update)/],
  ['build deletion', /pingcode build delete .*--yes/],
  ['deploy environments', /pingcode release env (list|get|create|update)/],
  ['deployment records', /pingcode release deploy (list|get|create|update)/],
  ['devops release delete is generic-layer only', /pingcode api DELETE \/v1\/release\//],
  // S2a — the pjm planning surface. Five rows, and four of them are about facts an agent
  // cannot see in `--help` alone: the sprint list lives under another command, a sprint
  // can never be deleted, "version" means four different resources in this API, and the
  // server ignores --project on a release read/write so a successful update is no proof
  // the project was right.
  ['sprints', /pingcode project sprint (get|create|update|bulk)/],
  ['sprint list is project meta sprints', /no `?sprint list`? leaf/i],
  ['sprints cannot be deleted', /A sprint cannot be deleted/i],
  ['releases', /pingcode project version (list|get|create|update|delete|bulk)/],
  ['release is not a wiki page version', /not a wiki page revision/i],
  // S2b — the work-item write surface plus project writes and members. Eight rows, and
  // six of them exist because the thing an agent gets wrong is invisible from `--help`:
  // `bulk-update` reports success for a property it ignored, a project can never be
  // deleted or archived, `work-item tag list` does not exist, the tag vocabulary answers
  // for the whole organisation while the write does not, `member remove` is generic-layer
  // only, and — the one that makes an agent loop — `link` and `relation` are two
  // different families that each refuse what the other takes.
  ['work-item bulk update', /pingcode project work-item bulk-update .*--id /],
  ['bulk update ignores sprint_id', /`?--sprint`? does not exist here/i],
  ['work-item deletion', /pingcode project work-item delete .*--yes/],
  ['typed work-item links', /pingcode project work-item link (add|list|get|delete)/],
  ['link is not relation', /`?link`? is work item ↔ work item, with a required type/i],
  ['no work-item tag list', /no `?work-item tag list`?, and there cannot be/i],
  ['work-item state history', /pingcode project work-item history (list|get)/],
  ['project writes are irreversible', /A project cannot be deleted, and cannot even be archived/i],
  ['project members', /pingcode project member (list|get|add)/],
  ['member remove is generic-layer only', /pingcode api DELETE \/v1\/pjm\/projects\//],
  ['relation types are organisation-wide', /pingcode project meta relation-types/],
  ['tag vocabulary is organisation-wide', /pingcode project meta tags/],
  // S3 — the testhub write surface. Eight rows, and six of them are for things an agent
  // cannot see in `--help` alone: the two bulk-run halves fail in OPPOSITE ways (one
  // per-element under a 200, one atomic), a case delete destroys its runs, the two
  // history reads answer different questions, "state" means three different vocabularies
  // here, and `--set` keys are mostly built-in fields that either 500 or edit the wrong
  // field. The remaining two are the plain import and plan-report flows.
  ['case bulk import', /pingcode testhub cases bulk-(create|update) /],
  ['case deletion cascades to runs', /deleting\s+a\s+case\s+.{0,40}removed\s+the\s+run|deletes the case's RUNS too/i],
  ['case execution history', /pingcode testhub cases history list /],
  ['run creation', /pingcode testhub runs (create|bulk-create) /],
  ['run bulk results', /pingcode testhub runs bulk-update /],
  ['run result history', /pingcode testhub runs history (list|get) /],
  ['plan report and lifecycle', /pingcode testhub plans update /],
  ['three vocabularies called state', /meta plan-states/],
  // S4 — the last two ship families. Three rows, and the third is the point of the
  // child: an agent that does not know "plan" is three unrelated resources will hand a
  // 需求排期 id to `testhub plans` (or a scheme id to either) and get a not-found it
  // cannot explain. The other two are the flows themselves, both read-only upstream.
  ['requirement schedules', /pingcode product plan (list|get) /],
  ['requirement state history', /pingcode product idea history (list|get) /],
  ['three resources called plan', /"?Plan"? is three unrelated things/i],
];

describe('SKILL.md is a well-formed skill', () => {
  it('exists, is frontmatter-tagged and names itself pingcode', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toMatch(/^name: pingcode$/m);
  });

  it('no longer tells the agent that ship is out of scope', () => {
    // The frontmatter used to list "Ship products/ideas/tickets" as a do-not-use,
    // which would have suppressed the whole surface.
    const frontmatter = skill.slice(0, skill.indexOf('\n---', 4));
    expect(frontmatter).not.toMatch(/Do NOT use[^]*Ship products/i);
    expect(frontmatter).toMatch(/产品管理|ship/i);
  });
});

describe('SKILL.md records the contract that does not scale with the surface (PRD R6)', () => {
  it('1. the authentication gate, with the scopes the commands need', () => {
    expect(skill).toContain('凭据管理');
    for (const scope of [
      'pcp:read:pjm:project',
      // S2b: the only genuinely new scope in the whole child — its other nineteen
      // endpoints all fall under `pjm:project` / `pjm:workitem` read+write, already
      // listed. Worth its own row because it is the one that makes an irreversible
      // create possible.
      'pcp:write:pjm:project',
      'pcp:read:pjm:workitem',
      'pcp:write:pjm:workitem',
      'pcp:read:global:team',
      'pcp:read:ship:product',
      'pcp:read:ship:idea',
      'pcp:write:ship:idea',
      'pcp:read:ship:ticket',
      'pcp:write:ship:ticket',
      'pcp:read:ship:configuration',
      'pcp:read:testhub:library',
      'pcp:write:testhub:library',
      'pcp:read:testhub:testcase',
      'pcp:write:testhub:testcase',
      'pcp:read:testhub:testplan',
      'pcp:write:testhub:testplan',
      'pcp:read:testhub:configuration',
      'pcp:read:devops:code',
      'pcp:write:devops:code',
      'pcp:read:devops:build',
      'pcp:write:devops:build',
      'pcp:read:devops:deploy',
      'pcp:write:devops:deploy',
      'pcp:read:pjm:sprint',
      'pcp:write:pjm:sprint',
      'pcp:read:pjm:release',
      'pcp:write:pjm:release',
    ]) {
      expect(skill, scope).toContain(scope);
    }
  });

  it('2. the --json stdout contract', () => {
    expect(skill).toContain('--json');
    expect(skill).toMatch(/stdout/i);
  });

  it('3. the --dry-run contract', () => {
    expect(skill).toContain('--dry-run');
  });

  it('4. every exit code has a row', () => {
    for (const exit of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(skill).toContain(`| ${exit} |`);
    }
  });

  it('5. a map to the per-module documents, marking the unbuilt ones', () => {
    for (const name of moduleFiles) {
      expect(skill, name).toContain(`modules/${name}`);
    }
    // The reserved files describe commands that do not exist yet; the map has to say
    // so, or an agent will read them as available surface.
    expect(skill).toMatch(/not built yet|reserved/i);
  });

  it('6. each allowlisted flow, and the rate limit that shapes all of them', () => {
    for (const [name, pattern] of REQUIRED_FLOWS) {
      expect(allDocs, name).toMatch(pattern);
    }
    expect(skill).toMatch(/200 requests per minute/i);
    expect(allDocs).toMatch(/replaces, it does not merge/i);
    expect(allDocs).toMatch(/best effort/i);
    expect(allDocs).toMatch(/no endpoint supports sorting/i);
  });
});

describe('the module documents carry the per-module rules (design D6.4)', () => {
  it('every module file back-links to SKILL.md', () => {
    for (const [name, body] of Object.entries(modules)) {
      expect(body, name).toContain('../SKILL.md');
    }
  });

  it('pjm keeps the id-resolution and work-item reference rules', () => {
    const pjm = modules['pjm.md'] ?? '';
    expect(pjm).toMatch(/project meta/);
    // states need (project, type) — the constraint that shapes every pjm write
    expect(pjm).toMatch(/requires \*\*both\*\* a project and a type/i);
    // `--type` on update/transition is a lookup aid, not a patched field
    expect(pjm).toMatch(/never written to the work\s*item|no patchable type field/i);
    // the four accepted reference forms
    expect(pjm).toMatch(/`?short_id`?/);
    expect(pjm).toMatch(/identifier such as `?SCR-5`?/i);
    // the 24 h cache and its escape hatch
    expect(pjm).toMatch(/--no-cache/);
  });

  it('ship keeps the product-scoped rules and the transition asymmetry', () => {
    const ship = modules['ship.md'] ?? '';
    expect(ship).toMatch(/product-scoped/i);
    expect(ship).toMatch(/product meta members/);
    expect(ship).toMatch(/option.{0,20}_id|option ids/i);
    expect(ship).toMatch(/nothing\s+in\s+ship\s+can\s+be\s+deleted/i);
    expect(ship).toMatch(/no\s+`--type`\s+(on|anywhere\s+on)\s+`idea`/i);
    // the asymmetry is about explanation, not enforcement: the server decides
    expect(ship).toMatch(/no state change is refused locally/i);
    expect(ship).toMatch(/does \*\*not\*\* refuse a transition/i);
    expect(ship).toMatch(/expect the server's exit code, not exit 2/i);
    expect(ship).toMatch(/reachable from the current one/i);
    expect(ship).toMatch(/--dry-run.{0,120}reachable set/is);
    expect(ship).toMatch(/no\s+idea\s+state-flow\s+endpoint/i);
    expect(ship).toMatch(/state it is already in/i);
  });

  // S4: the two read-only families, and the disambiguation that is the whole point of
  // documenting them. Each row is a fact an agent cannot get from `--help` alone.
  it('ship separates the three things called a plan, and marks both new families read-only', () => {
    const ship = modules['ship.md'] ?? '';
    // the 排期 ↔ 测试计划 ↔ 配置方案 table, by all three of its rows
    expect(ship).toMatch(/pingcode product plan list --product/);
    expect(ship).toMatch(/pingcode testhub plans list --library/);
    expect(ship).toMatch(/ticket_state_plans/);
    // read-only is upstream's doing (HTTP 405), not a scoping decision
    expect(ship).toMatch(/HTTP 405/);
    // the two-structures-for-one-resource trap between plan list and meta idea-plans
    expect(ship).toMatch(/two structures for one resource/i);
    // history is states only; the activity feed is the other half
    expect(ship).toMatch(/\*\*State changes only\.\*\*/);
    expect(ship).toMatch(/product idea activity/);
    // filters that are accepted and then ignored, which is why no flag exists
    expect(ship).toMatch(/\?name=/);
    expect(ship).toMatch(/ignoring\s+all three/i);
    // and the exit-code surprise on a missing schedule
    expect(ship).toMatch(/exits \*\*7\*\*, not 5/);
  });

  it('testhub keeps the library-scoping, run-write and date rules', () => {
    const testhub = modules['testhub.md'] ?? '';
    expect(testhub).toMatch(/library-scoped/i);
    expect(testhub).toMatch(/never\s+share\s+a\s+state,\s+type\s+or\s+status\s+id/i);
    expect(testhub).toMatch(/all-or-nothing/i);
    expect(testhub).toMatch(/`?status_id`?\s+is\s+required\s+by\s+the\s+API\s+even\s+on\s+PATCH/i);
    expect(testhub).toMatch(/stays\s+unassigned/i);
    expect(testhub).toMatch(/only\s+way\s+to\s+delete\s+a\s+run/i);
    expect(testhub).toMatch(/cannot\s+filter\s+by\s+library/i);
    expect(testhub).toMatch(/important-levels`?\s+takes\s+no\s+`?--library/i);
    expect(testhub).toMatch(/cannot\s+write\s+a\s+run\s+at\s+all/i);
    expect(testhub).toMatch(/test_library_id/);
    expect(testhub).toMatch(/`?short_id`?\s+is\s+read-only/i);
    expect(testhub).toMatch(/no\s+`?--maintenance`?\s+flag/i);
    expect(testhub).toMatch(/unique\s+across\s+the\s+organisation/i);
    // Corrected in S3: there is no library DELETE, but a library PATCH *does* exist
    // upstream and is reachable through the generic layer. The doc used to say neither
    // existed, which sent a reader looking for a workaround that was never needed.
    expect(testhub).toMatch(/no\s+library\s+DELETE/i);
    expect(testhub).toMatch(/pingcode api PATCH \/v1\/testhub\/libraries\//);
    expect(testhub).toMatch(/no\s+`?kind`?\s+discriminator|carries\s+no\s+kind/i);
    // the --start/--end asymmetry: only prose can explain why the two ends differ
    expect(testhub).toMatch(/YYYY-MM-DD/);
    expect(testhub).toMatch(/00:00:00/);
    expect(testhub).toMatch(/23:59:59/);
    expect(testhub).toMatch(/\*?through\*?\s+the\s+end\s+date/i);
    expect(testhub).toMatch(/2026-8-1/);
    expect(testhub).toMatch(/milliseconds/i);
  });

  it('testhub records the S3 write-surface traps an agent cannot see in --help', () => {
    const testhub = modules['testhub.md'] ?? '';
    // The two bulk-run halves fail in opposite ways — the single most script-breaking
    // fact in the module, and undocumented upstream.
    expect(testhub).toMatch(/per-element best effort/i);
    expect(testhub).toMatch(/atomic/i);
    // The caps: 100 is the server's own limit on four endpoints, 50 is a CLI-side
    // conservatism on the one endpoint that enforces nothing.
    expect(testhub).toMatch(/capped at\s+\*?\*?100\*?\*?|100\*?\*?\s+by the server/i);
    expect(testhub).toMatch(/enforces\s+\*?\*?nothing\*?\*?/i);
    // The destructive one, and its blast radius.
    expect(testhub).toMatch(/takes the case's runs with it/i);
    expect(testhub).toMatch(/soft\*?\*?-deleted/i);
    // The two histories answer different questions, and neither accepts a short_id.
    expect(testhub).toMatch(/row per\s+\*?\*?run\*?\*?\s+of that case/i);
    expect(testhub).toMatch(/id-only/i);
    // Three vocabularies called "state", disambiguated in a table.
    expect(testhub).toMatch(/meta plan-states/);
    expect(testhub).toMatch(/organisation-level\*?\*?\s+plan state|plan state.{0,60}organisation/i);
    // Plan update: partial, verbatim dates, unclearable summary.
    expect(testhub).toMatch(/stored\s+\*?\*?verbatim\*?\*?/i);
    expect(testhub).toMatch(/replaced but never cleared/i);
    // `--set` is a warning as much as a lookup.
    expect(testhub).toMatch(/rewrites the top-level `?description`?/i);
    expect(testhub).toMatch(/no`?\*?\*?\s+`?testhub-case-property`? kind|no\*?\*? `testhub-case-property`/i);
  });

  it('scm keeps the platform hop, the identity-is-not-a-member rule and the PUT exclusion', () => {
    const scm = modules['scm.md'] ?? '';
    // the bootstrap hop and the token type, neither discoverable by trial and error
    expect(scm).toMatch(/企业令牌/);
    expect(scm).toMatch(/pcp:(read|write):devops:code/);
    // the trap the URL sets up: /v1/scm/products is not a ship product
    expect(scm).toMatch(/\*?not\*?\s+a ship product/i);
    // what a platform user actually is — the single most misleading name in the module
    expect(scm).toMatch(/git author identity, not a PingCode member/i);
    expect(scm).toMatch(/no\s+`?user_id`?/i);
    // full_name is the unique key, and ?name= is ignored upstream
    expect(scm).toMatch(/`?full_name`?\s+\(`?owner\/name`?\) is the unique key/i);
    expect(scm).toMatch(/only list filter/i);
    // owner_name upserts — the live finding that turns a typo into an undeletable row
    expect(scm).toMatch(/creates the identity if it does not exist/i);
    // three-state booleans, and why
    expect(scm).toMatch(/true`? \/ `?false/);
    // no delete anywhere, and PUT only through the escape hatch
    expect(scm).toMatch(/No DELETE exists upstream/i);
    expect(scm).toMatch(/pingcode api PUT \/v1\/scm\/products/);
    // S1c: the two facts about pull requests and reviews that `--help` alone cannot
    // carry, because both are about what the API is *missing*.
    //  - `status` is mandatory on the pull request PATCH, so an omitted `--status` costs
    //    a read rather than sending an incomplete body;
    //  - a review is addressed under one pull request and there is no wider list, so
    //    "show me every review" is not an operation an agent should look for.
    expect(scm).toMatch(/required by the API on every patch/i);
    expect(scm).toMatch(/no repository-wide or organisation-wide\s+review list/i);
    // …and that a PR, unlike a branch, can never be withdrawn once written.
    expect(scm).toMatch(/cannot be withdrawn/i);
  });

  it('has no reserved module left: every document describes real commands', () => {
    // `api.md` left the reserved list when F3 landed the `api` group, `crosscutting.md`
    // when F5 landed the four injected families, `scm.md` when S1a landed the platform /
    // platform-user / repo surface, and `cicd.md` when S1d landed `build` + `release` —
    // which empties the list entirely. The assertion is inverted rather than deleted:
    // **no** module may claim to describe unbuilt surface, and if a future task adds a
    // placeholder again it has to say so here deliberately.
    //
    // The forward assertion below is what keeps this honest in the other direction: a
    // document that mentions a command the tree does not have fails the suite.
    for (const [name, body] of Object.entries(modules)) {
      expect(body, name).not.toMatch(/do not exist yet/i);
      expect(body, name).not.toMatch(/^\*\*Reserved/im);
    }
  });

  it('crosscutting keeps the mount table and the four traps it exists to record', () => {
    const cross = modules['crosscutting.md'] ?? '';
    // the mount table, including the entity that is deliberately absent
    expect(cross).toMatch(/principal_type/);
    expect(cross).toMatch(/test_run/);
    expect(cross).toMatch(/test plan is not an object these families accept/i);
    // relations: no type, cross-kind only, asymmetric, mirrored
    expect(cross).toMatch(/takes no relation type/i);
    expect(cross).toMatch(/work item ↔ work item is a different family/i);
    expect(cross).toMatch(/relation_types/);
    expect(cross).toMatch(/mirrored pair/i);
    expect(cross).toMatch(/mandatory on `?relation list`?/i);
    // comments: the soft delete
    expect(cross).toMatch(/does not remove the row/i);
    // attachments: no file upload, and the undocumented comment_id requirement
    expect(cross).toMatch(/multipart\/form-data/);
    expect(cross).toMatch(/`?--comment-id`? is required/i);
    expect(cross).toMatch(/100039/);
    // activities: no webhooks
    expect(cross).toMatch(/no webhook API and no global activity stream/i);
    // and it must not tell the agent this file is still a placeholder
    expect(cross).not.toMatch(/do not exist yet/i);
  });

  it('the api module carries the generic layer\'s own rules', () => {
    const api = modules['api.md'] ?? '';
    // The two rules that surprise people, and the reason the module exists at all.
    expect(api).toMatch(/`?--json`? is a no-op on the five verbs/);
    expect(api).toMatch(/`?DELETE`? requires `?--yes`?/i);
    expect(api).toMatch(/459/);
    // the pre-flight refusals, so an agent expects exit 2 rather than a 4xx
    expect(api).toMatch(/did you mean/i);
    expect(api).toMatch(/browser authorization page/i);
    // the seven unreachable endpoints and the 61 reachable machine-only ones
    expect(api).toMatch(/\/v1\/myself/);
    expect(api).toMatch(/61/);
    // PUT is generic-layer-only on purpose
    expect(api).toMatch(/prefer `?PATCH`?/i);
    // and it must not tell the agent this file is still a placeholder
    expect(api).not.toMatch(/do not exist yet/i);
  });
});

describe('the docs mention no command path the CLI does not have', () => {
  it('every `pingcode …` path in SKILL.md and every module resolves', () => {
    const root = program();
    const mentioned = new Set<string>();
    // Same line only: a command path never wraps, and `\s` would swallow the
    // frontmatter's `name: pingcode` into the next key.
    const re = /pingcode((?:[ \t]+[a-z][a-z0-9-]*)+)/g;
    for (let match = re.exec(allDocs); match !== null; match = re.exec(allDocs)) {
      const tokens = (match[1] ?? '')
        .trim()
        .split(/\s+/)
        .filter((token) => token !== '');
      if (tokens.length === 0) continue;
      mentioned.add(tokens.slice(0, 2).join(' '));
    }

    expect(mentioned.size).toBeGreaterThan(8);

    const missing: string[] = [];
    for (const entry of mentioned) {
      const [first, second] = entry.split(' ');
      if (first === undefined) continue;
      const top = root.commands.find((command) => command.name() === first);
      if (top === undefined) {
        missing.push(`pingcode ${entry}`);
        continue;
      }
      // Only check as deep as the tree actually goes; args are not commands.
      if (top.commands.length === 0 || second === undefined) continue;
      if (!top.commands.some((command) => command.name() === second)) {
        missing.push(`pingcode ${entry}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('does not assert the reverse: a leaf may go undocumented (PRD R6)', () => {
    // Guard against the deleted assertion creeping back in. If someone reintroduces
    // "every leaf must appear in SKILL.md", this test tells them why it was removed.
    const leaves = program()
      .commands.filter((command) => command.name() !== 'help')
      .flatMap((command) => leafPaths(command));
    expect(leaves.length).toBeGreaterThan(0);
    const documented = leaves.filter((parts) => allDocs.includes(`pingcode ${parts.join(' ')}`));
    // Most leaves are documented, and that is good — but it is not enforced, because
    // enforcing it makes the docs a merge point for every parallel child.
    expect(documented.length).toBeGreaterThan(0);
  });
});

describe('install-skill script', () => {
  it('is wired to the npm script and imports nothing local', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['skill:install']).toContain('scripts/install-skill.ts');

    const script = readFileSync(
      fileURLToPath(new URL('../../scripts/install-skill.ts', import.meta.url)),
      'utf8',
    );
    // `node --experimental-strip-types` cannot resolve a TS import graph.
    const imports = [...script.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.every((specifier) => specifier?.startsWith('node:'))).toBe(true);
    expect(script).toContain("'skills'");
    expect(script).toContain("'SKILL.md'");
    // Both destinations are global (user-level); a project-local install is not offered.
    expect(script).toContain("'.claude', 'skills', 'pingcode'");
    expect(script).toContain("'.config', 'opencode'");
    expect(script).not.toContain('process.cwd()');
    expect(script).toContain('--dry-run');
  });

  it('installs the module documents too, not just SKILL.md', () => {
    // SKILL.md links to `modules/*.md`; an install that copied only SKILL.md would
    // hand the agent a document full of dead links (design D6.4).
    const script = readFileSync(
      fileURLToPath(new URL('../../scripts/install-skill.ts', import.meta.url)),
      'utf8',
    );
    expect(script).toContain('MODULES_DIR_NAME');
    expect(script).toContain('readdirSync');
    // Read the directory rather than hardcoding a list, so a child that adds a module
    // file does not also have to remember to register it here.
    expect(script).not.toMatch(/const MODULE_FILES\s*=\s*\[/);
  });
});
