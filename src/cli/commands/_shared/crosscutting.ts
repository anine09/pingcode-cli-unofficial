import type { Command } from 'commander';
import {
  createComment,
  createRelation,
  createSnippetAttachment,
  deleteAttachment,
  deleteComment,
  deleteRelation,
  getActivity,
  getAttachment,
  getComment,
  getRelation,
  iterateActivities,
  iterateAttachments,
  iterateComments,
  iterateRelations,
  listActivities,
  listAttachments,
  listComments,
  listRelations,
  RELATION_TARGETS,
  SNIPPET_FORMATS,
} from '../../../api/common';
import type { Ctx } from '../../../core/context';
import { ApiError, UsageError } from '../../../core/errors';
import { readTextFile } from '../../../core/jsonInput';
import { collect } from '../../../core/paginate';
import type {
  Activity,
  Attachment,
  Comment,
  Principal,
  PrincipalType,
  Relation,
} from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import {
  addPagingOptions,
  contextFor,
  modeOf,
  printCollection,
  printPage,
  printResource,
  readPaging,
  refName,
  requireFlag,
  timestampCell,
  type PagingFlags,
} from '../common';

/**
 * `addCrosscutting(parent, principalType, opts)` — the four cross-object families,
 * injected once and mounted many times (design D5).
 *
 * **Why there is no top-level `pingcode comment` group** (design D5.4): a top-level
 * form would have to ask the user for `--principal-type`, and that is a failure mode
 * — a mistyped value silently hangs a comment on a different kind of object, or
 * returns an error that mentions nothing the user typed. Under
 * `pingcode project work-item comment add`, `principal_type=work_item` is *the command
 * path*. Everything a top-level group could express is already free through
 * `pingcode api GET /v1/comments --query principal_type=… --query principal_id=…`, so
 * the group would be strictly worse than something that already exists.
 *
 * **Help-snapshot budget** (design D5.6): every mount produces the same help modulo
 * the command path, the entity noun and the one line listing the accepted relation
 * targets. `test/crosscutting.test.ts` snapshots one mount and asserts the rest
 * structurally, so five mounts cost one snapshot entry instead of ~40.
 *
 * **What each mount must supply** is only what actually varies: which families the
 * API accepts for that `principal_type`, and how to turn the entity reference the
 * user typed into the real id `principal_id` needs. Nothing else — no per-entity
 * copies of these fourteen commands exist anywhere.
 *
 * **Uniform two-positional signatures** (design D5.3). `comment`/`attachment`/
 * `activity` genuinely need the parent reference on every call, because the API
 * requires the principal in the query even to read one row by id. `relation` does
 * **not** — `/v1/relations/{id}` is addressed by relation id alone — but it takes the
 * parent reference anyway and does not send it, so the four families do not each have
 * a different shape. The help says so, and no request is spent resolving it.
 */

/** The four families. A mount declares which of them the API accepts for its type. */
export type CrosscuttingFamily = 'relation' | 'comment' | 'attachment' | 'activity';

export const CROSSCUTTING_FAMILIES: readonly CrosscuttingFamily[] = [
  'relation',
  'comment',
  'attachment',
  'activity',
];

export type CrosscuttingOptions = {
  /**
   * Turn the reference the user typed into the real id. Every family sends
   * `principal_id`, and **no cross-object endpoint accepts a `short_id` or an
   * identifier** — it is not in any of their parameter tables — so this runs first
   * and costs one read. Each mount passes its group's own resolver, which is also
   * what keeps this file free of per-module imports.
   */
  resolveId: (ctx: Ctx, ref: string) => Promise<string>;
  /** Only the families this `principal_type` is accepted by. Asserted against the catalog. */
  families?: readonly CrosscuttingFamily[];
};

type RefArg = string;
type YesFlag = { yes?: boolean | undefined };
type ScopeFlag = { commentId?: string | undefined };
type TargetTypeFlag = { targetType: string };
type AddRelationFlags = TargetTypeFlag & { targetId: string };
type AddCommentFlags = { text: string; replyTo?: string | undefined };
type AddSnippetFlags = {
  commentId: string;
  title: string;
  format: string;
  content?: string | undefined;
  contentFile?: string | undefined;
};

/**
 * The marker the help-equality test keys on. The line after it is the one piece of
 * per-mount help text, and it is checked separately against `RELATION_TARGETS`
 * instead of being compared byte-for-byte across mounts.
 */
export const RELATION_TARGET_HELP_PREFIX = 'accepted --target-type for this principal:';

export function addCrosscutting(
  parent: Command,
  principalType: PrincipalType,
  options: CrosscuttingOptions,
): void {
  const noun = nounOf(principalType);
  const families = options.families ?? CROSSCUTTING_FAMILIES;

  // Registration order is the declaration order above, not the caller's, so every
  // mount lists its subgroups the same way and the help comparison stays meaningful.
  for (const family of CROSSCUTTING_FAMILIES) {
    if (!families.includes(family)) continue;
    switch (family) {
      case 'relation':
        addRelations(parent, principalType, noun, options);
        break;
      case 'comment':
        addComments(parent, principalType, noun, options);
        break;
      case 'attachment':
        addAttachments(parent, principalType, noun, options);
        break;
      case 'activity':
        addActivities(parent, principalType, noun, options);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// relations
// ---------------------------------------------------------------------------

function relationColumns(): Column<Relation>[] {
  return [
    { header: 'ID', value: (relation) => relation.id },
    { header: 'TARGET TYPE', value: (relation) => relation.target_type ?? '' },
    {
      header: 'TARGET',
      value: (relation) => idOf(relation.target, 'identifier') ?? refName(relation.target),
    },
    { header: 'TITLE', value: (relation) => idOf(relation.target, 'title') ?? '', flex: true },
  ];
}

function addRelations(
  parent: Command,
  principalType: PrincipalType,
  noun: string,
  options: CrosscuttingOptions,
): void {
  const group = parent
    .command('relation')
    .description(`关联 cross-kind links of a ${noun} (principal_type=${principalType})`);

  group.addHelpText(
    'after',
    `\n${RELATION_TARGET_HELP_PREFIX} ${[...RELATION_TARGETS[principalType]].join(' ')}\n` +
      'The API declares no vocabulary for this endpoint, so that list is what a live\n' +
      'tenant accepted — it is a hint, not a rule, and nothing is refused locally.\n' +
      'Links between two objects of the same kind are a different, typed family:\n' +
      'reach those with `pingcode api POST /v1/pjm/work_items/{id}/relations`.\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list the links of one object, filtered by the kind on the other end')
        .argument('<ref>', refHelp(noun))
        .requiredOption('--target-type <kind>', TARGET_TYPE_HELP),
    ),
    { hidden: true },
  ).action(async (ref: RefArg, flags: PagingFlags & TargetTypeFlag, command: Command) => {
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const targetType = targetTypeOf(flags.targetType);
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateRelations(ctx, principal, targetType, {
          pageSize: paging.pageSize,
          limit: paging.limit,
        }),
      );
      printCollection(values, relationColumns(), modeOf(ctx), { all: true });
      return;
    }

    const page = await listRelations(ctx, principal, targetType, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, relationColumns(), modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one link (the reference is taken for symmetry and not sent)')
      .argument('<ref>', refHelp(noun))
      .argument('<relation-id>', 'link id, as printed by list'),
    { hidden: true },
  ).action(async (_ref: RefArg, relationId: string, _flags: unknown, command: Command) => {
    const { ctx } = contextFor(command);
    printRelation(await getRelation(ctx, requireFlag(relationId, '<relation-id>')), ctx);
  });

  addGlobalOptions(
    group
      .command('add')
      .description('link this object to another one')
      .argument('<ref>', refHelp(noun))
      .requiredOption('--target-type <kind>', TARGET_TYPE_HELP)
      .requiredOption('--target-id <id>', 'id of the object on the other end — an id, never a name'),
    { hidden: true },
  ).action(async (ref: RefArg, flags: AddRelationFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const targetType = targetTypeOf(flags.targetType);
    try {
      const relation = await createRelation(ctx, principal, {
        target_type: targetType,
        target_id: requireFlag(flags.targetId, '--target-id'),
      });
      printRelation(relation, ctx);
    } catch (error) {
      explainRejectedPair(error, principalType, targetType);
      throw error;
    }
  });

  addGlobalOptions(
    group
      .command('delete')
      .description('remove a link — both directions go at once (the reference is not sent)')
      .argument('<ref>', refHelp(noun))
      .argument('<relation-id>', 'link id, as printed by list')
      .option('--yes', YES_HELP),
    { hidden: true },
  ).action(async (_ref: RefArg, relationId: string, flags: YesFlag, command: Command) => {
    const id = requireFlag(relationId, '<relation-id>');
    confirm(flags, `the link ${id}`, 'links are recreatable, but the id will not come back');
    const { ctx } = contextFor(command);
    printRelation(await deleteRelation(ctx, id), ctx);
  });
}

function printRelation(relation: Relation, ctx: Ctx): void {
  printResource(
    relation,
    [
      ['id', relation.id],
      ['principal', `${relation.principal_type ?? ''} ${refName(relation.principal)}`.trim()],
      ['target', `${relation.target_type ?? ''} ${refName(relation.target)}`.trim()],
      ['target title', idOf(relation.target, 'title') ?? ''],
      ['target url', idOf(relation.target, 'html_url') ?? idOf(relation.target, 'url') ?? ''],
    ],
    modeOf(ctx),
  );
}

/**
 * Two rejections whose messages point at the wrong thing, explained here because
 * `core/wire.ts` cannot know any of this (it is a PRD R1 no-touch file and has no
 * concept of a mount point).
 *
 *  - `100049` is reported as an unsupported `'principal_type'` no matter what was
 *    actually wrong: an unaccepted `target_type` beside this principal, or a missing
 *    one. The principal is fixed by the command path, so it is almost never the cause.
 *  - `100107` (`不支持的工作项类型`) is about the *type* of the work item on the other
 *    end, not the kind. From a test case, only 需求 (story) and 缺陷 (bug) are
 *    accepted; from a test run, only 缺陷. Nothing in the message says which end it
 *    means, and the CLI cannot check it in advance without reading the target first —
 *    which would be a request spent to refuse a call the server refuses anyway.
 *
 * Neither code is in `ERROR_CODE_OVERRIDES`: both are refused arguments, not missing
 * rows, so exit 7 is correct for both.
 */
function explainRejectedPair(
  error: unknown,
  principalType: PrincipalType,
  targetType: PrincipalType,
): void {
  if (!(error instanceof ApiError)) return;

  if (error.code === UNSUPPORTED_PRINCIPAL_CODE) {
    const accepted = [...RELATION_TARGETS[principalType]].join(' ');
    errLine(
      paint.dim(
        `the API reports this as an unsupported 'principal_type', but the pair is what it rejects: ` +
          `${principalType} → ${targetType}. Live, ${principalType} links to: ${accepted}. ` +
          `Same-kind work-item links live on /v1/pjm/work_items/{id}/relations instead.`,
      ),
    );
    return;
  }

  if (error.code === UNSUPPORTED_WORK_ITEM_TYPE_CODE) {
    errLine(
      paint.dim(
        `the kinds are fine (${principalType} → ${targetType}); it is the work item's *type* that ` +
          `is refused. From a test_case only 需求/story and 缺陷/bug are accepted, and from a ` +
          `test_run only 缺陷/bug — an epic, feature or task target is rejected here even though ` +
          `the same link created from the work-item side succeeds.`,
      ),
    );
  }
}

/** `不支持的'principal_type'` — deliberately kept out of `ERROR_CODE_OVERRIDES`. */
const UNSUPPORTED_PRINCIPAL_CODE = '100049';

/** `不支持的工作项类型` — likewise a refused argument, so likewise exit 7. */
const UNSUPPORTED_WORK_ITEM_TYPE_CODE = '100107';

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

function commentColumns(): Column<Comment>[] {
  return [
    { header: 'ID', value: (comment) => comment.id },
    // Not decoration: a deleted comment stays in this list, and whether its text is
    // emptied depends on the module (pjm empties it, ship does not), so this flag is
    // the only reliable answer to "is this comment still there".
    { header: 'STATE', value: (comment) => (comment.is_deleted ? 'deleted' : 'live') },
    { header: 'ATTACH', value: (comment) => String(comment.attachment_count ?? 0) },
    { header: 'AUTHOR', value: (comment) => refName(comment.created_by) },
    { header: 'CREATED', value: (comment) => timestampCell(comment.created_at) },
    { header: 'CONTENT', value: (comment) => oneLine(comment.content), flex: true },
  ];
}

function addComments(
  parent: Command,
  principalType: PrincipalType,
  noun: string,
  options: CrosscuttingOptions,
): void {
  const group = parent
    .command('comment')
    .description(`评论 comments on a ${noun} (principal_type=${principalType})`);

  group.addHelpText(
    'after',
    '\ndelete is a **soft** delete: the row stays in list with STATE=deleted, so treat\n' +
      'that column as the answer to "is it still there". pjm also empties the text;\n' +
      'ship keeps it, so an absent body is not the signal either.\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list the comments on one object, newest first as the API returns them')
        .argument('<ref>', refHelp(noun)),
    ),
    { hidden: true },
  ).action(async (ref: RefArg, flags: PagingFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateComments(ctx, principal, { pageSize: paging.pageSize, limit: paging.limit }),
      );
      printCollection(values, commentColumns(), modeOf(ctx), { all: true });
      return;
    }

    const page = await listComments(ctx, principal, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, commentColumns(), modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one comment (the API needs the parent, an id alone is not enough)')
      .argument('<ref>', refHelp(noun))
      .argument('<comment-id>', 'comment id, as printed by list'),
    { hidden: true },
  ).action(async (ref: RefArg, commentId: string, _flags: unknown, command: Command) => {
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const comment = await getComment(ctx, principal, requireFlag(commentId, '<comment-id>'));
    printComment(comment, ctx);
  });

  addGlobalOptions(
    group
      .command('add')
      .description('comment on this object — the write-back point for an automated flow')
      .argument('<ref>', refHelp(noun))
      .requiredOption('--text <text>', 'comment body, sent verbatim as plain text')
      .option('--reply-to <comment-id>', 'make this a reply to an existing comment on this object'),
    { hidden: true },
  ).action(async (ref: RefArg, flags: AddCommentFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const comment = await createComment(ctx, principal, {
      content: requireFlag(flags.text, '--text'),
      ...(flags.replyTo === undefined ? {} : { reply_comment_id: flags.replyTo }),
    });
    printComment(comment, ctx);
  });

  addGlobalOptions(
    group
      .command('delete')
      .description('soft-delete a comment: the row survives, flagged deleted')
      .argument('<ref>', refHelp(noun))
      .argument('<comment-id>', 'comment id, as printed by list')
      .option('--yes', YES_HELP),
    { hidden: true },
  ).action(async (ref: RefArg, commentId: string, flags: YesFlag, command: Command) => {
    const id = requireFlag(commentId, '<comment-id>');
    confirm(flags, `the comment ${id}`, 'the row is flagged deleted and cannot be restored');
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    printComment(await deleteComment(ctx, principal, id), ctx);
  });
}

function printComment(comment: Comment, ctx: Ctx): void {
  printResource(
    comment,
    [
      ['id', comment.id],
      ['state', comment.is_deleted ? 'deleted' : 'live'],
      ['author', refName(comment.created_by)],
      ['created', timestampCell(comment.created_at)],
      ['reply to', refName(comment.replied_comment)],
      ['attachments', String(comment.attachment_count ?? 0)],
      ['content', comment.content ?? ''],
    ],
    modeOf(ctx),
  );
}

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

function attachmentColumns(): Column<Attachment>[] {
  return [
    { header: 'ID', value: (attachment) => attachment.id },
    { header: 'KIND', value: (attachment) => attachment.type ?? '' },
    { header: 'TITLE', value: (attachment) => attachment.title ?? '', flex: true },
    { header: 'FORMAT', value: (attachment) => attachment.format ?? attachment.ext ?? '' },
    { header: 'SIZE', value: (attachment) => String(attachment.size ?? '') },
    { header: 'CREATED', value: (attachment) => timestampCell(attachment.created_at) },
  ];
}

function addAttachments(
  parent: Command,
  principalType: PrincipalType,
  noun: string,
  options: CrosscuttingOptions,
): void {
  const group = parent
    .command('attachment')
    .description(`附件 attachments of a ${noun} (principal_type=${principalType})`);

  group.addHelpText(
    'after',
    '\nThere is no file upload here: the API takes a file as one-step multipart/form-data,\n' +
      'which this CLI cannot send, so only code snippets can be written. Snippets always\n' +
      'hang off a comment — create one first and pass its id as --comment-id, on write\n' +
      'and on every read, or the snippet is reported as not found.\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list attachments — without --comment-id only the object-level files')
        .argument('<ref>', refHelp(noun))
        .option('--comment-id <id>', COMMENT_SCOPE_HELP),
    ),
    { hidden: true },
  ).action(async (ref: RefArg, flags: PagingFlags & ScopeFlag, command: Command) => {
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const scope = scopeOf(flags);
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateAttachments(ctx, principal, scope, {
          pageSize: paging.pageSize,
          limit: paging.limit,
        }),
      );
      printCollection(values, attachmentColumns(), modeOf(ctx), { all: true });
      return;
    }

    const page = await listAttachments(ctx, principal, scope, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, attachmentColumns(), modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one attachment — a snippet needs the --comment-id it lives under')
      .argument('<ref>', refHelp(noun))
      .argument('<attachment-id>', 'attachment id, as printed by list')
      .option('--comment-id <id>', COMMENT_SCOPE_HELP),
    { hidden: true },
  ).action(async (ref: RefArg, attachmentId: string, flags: ScopeFlag, command: Command) => {
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const attachment = await getAttachment(
      ctx,
      principal,
      requireFlag(attachmentId, '<attachment-id>'),
      scopeOf(flags),
    );
    printAttachment(attachment, ctx);
  });

  addGlobalOptions(
    group
      .command('add-snippet')
      .description('attach a code snippet to a comment (the only attachment write there is)')
      .argument('<ref>', refHelp(noun))
      .requiredOption('--comment-id <id>', 'comment to hang it on — required by the API in practice')
      .requiredOption('--title <text>', 'snippet title, shown in the UI')
      .requiredOption('--format <language>', `language, one of: ${SNIPPET_FORMATS.join(' ')}`)
      .option('--content <text>', 'snippet body, sent verbatim')
      .option('--content-file <path>', 'snippet body, read from a file instead of --content'),
    { hidden: true },
  ).action(async (ref: RefArg, flags: AddSnippetFlags, command: Command) => {
    const content = await snippetContent(flags);
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const attachment = await createSnippetAttachment(ctx, principal, {
      comment_id: requireFlag(flags.commentId, '--comment-id'),
      title: requireFlag(flags.title, '--title'),
      format: requireFlag(flags.format, '--format'),
      content,
    });
    printAttachment(attachment, ctx);
  });

  addGlobalOptions(
    group
      .command('delete')
      .description('delete an attachment for good — no soft delete, no undo')
      .argument('<ref>', refHelp(noun))
      .argument('<attachment-id>', 'attachment id, as printed by list')
      .option('--comment-id <id>', COMMENT_SCOPE_HELP)
      .option('--yes', YES_HELP),
    { hidden: true },
  ).action(
    async (ref: RefArg, attachmentId: string, flags: ScopeFlag & YesFlag, command: Command) => {
      const id = requireFlag(attachmentId, '<attachment-id>');
      confirm(flags, `the attachment ${id}`, 'this one is not recoverable, unlike a comment');
      const { ctx } = contextFor(command);
      const principal = await principalOf(ctx, principalType, ref, noun, options);
      printAttachment(await deleteAttachment(ctx, principal, id, scopeOf(flags)), ctx);
    },
  );
}

/**
 * `--content` and `--content-file` are mutually exclusive and one is required.
 * Reading the file happens in `core` — `cli/` does no filesystem IO (design §2,
 * `test/layering.test.ts`) — and it is read **verbatim**: a snippet is not JSON, so
 * nothing parses or trims it.
 */
async function snippetContent(flags: AddSnippetFlags): Promise<string> {
  const hasInline = flags.content !== undefined;
  const hasFile = flags.contentFile !== undefined;
  if (hasInline && hasFile) {
    throw new UsageError('--content and --content-file are mutually exclusive', {
      hint: 'pass the snippet inline, or point at a file — not both',
    });
  }
  if (hasFile) return await readTextFile(flags.contentFile ?? '', '--content-file');
  if (hasInline) return flags.content ?? '';
  throw new UsageError('a snippet needs --content <text> or --content-file <path>', {
    hint: 'an empty snippet is rejected by the API, so one of the two is required',
  });
}

function printAttachment(attachment: Attachment, ctx: Ctx): void {
  printResource(
    attachment,
    [
      ['id', attachment.id],
      ['kind', attachment.type ?? ''],
      ['title', attachment.title ?? ''],
      ['format', attachment.format ?? attachment.ext ?? ''],
      ['size', String(attachment.size ?? '')],
      ['lines', String(attachment.line ?? '')],
      ['author', refName(attachment.created_by)],
      ['created', timestampCell(attachment.created_at)],
      // Time-limited by the server, so it is shown but never stored anywhere.
      ['download', attachment.download_url ?? ''],
      ['content', attachment.content ?? ''],
    ],
    modeOf(ctx),
  );
}

// ---------------------------------------------------------------------------
// activities
// ---------------------------------------------------------------------------

function activityColumns(): Column<Activity>[] {
  return [
    { header: 'ID', value: (activity) => activity.id },
    { header: 'WHEN', value: (activity) => timestampCell(activity.created_at) },
    { header: 'EVENT', value: (activity) => activity.template ?? activity.type ?? '' },
    { header: 'BY', value: (activity) => refName(activity.created_by) },
    { header: 'SUMMARY', value: (activity) => oneLine(activity.summary), flex: true },
  ];
}

function addActivities(
  parent: Command,
  principalType: PrincipalType,
  noun: string,
  options: CrosscuttingOptions,
): void {
  const group = parent
    .command('activity')
    .description(`活动记录 audit trail of a ${noun} (principal_type=${principalType})`);

  group.addHelpText(
    'after',
    '\nRead-only, and per-object: this API has no webhooks and no global change feed,\n' +
      'so polling one object here is the only change stream there is.\n' +
      'EVENT is the machine-readable name; SUMMARY is Chinese prose and not a contract.\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list what happened to one object, as the API orders it')
        .argument('<ref>', refHelp(noun)),
    ),
    { hidden: true },
  ).action(async (ref: RefArg, flags: PagingFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateActivities(ctx, principal, { pageSize: paging.pageSize, limit: paging.limit }),
      );
      printCollection(values, activityColumns(), modeOf(ctx), { all: true });
      return;
    }

    const page = await listActivities(ctx, principal, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, activityColumns(), modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one audit row, with its free-form content object')
      .argument('<ref>', refHelp(noun))
      .argument('<activity-id>', 'activity id, as printed by list'),
    { hidden: true },
  ).action(async (ref: RefArg, activityId: string, _flags: unknown, command: Command) => {
    const { ctx } = contextFor(command);
    const principal = await principalOf(ctx, principalType, ref, noun, options);
    const activity = await getActivity(ctx, principal, requireFlag(activityId, '<activity-id>'));
    printResource(
      activity,
      [
        ['id', activity.id],
        ['when', timestampCell(activity.created_at)],
        ['event', activity.template ?? ''],
        ['verb', activity.type ?? ''],
        ['by', refName(activity.created_by)],
        ['client', activity.client ?? ''],
        ['summary', activity.summary ?? ''],
      ],
      modeOf(ctx),
    );
  });
}

// ---------------------------------------------------------------------------
// shared bits — every string below is identical at every mount by construction
// ---------------------------------------------------------------------------

const YES_HELP = 'confirm the deletion — required, and there is no undo on this API';

const TARGET_TYPE_HELP =
  'kind of object on the other end — see the note under `relation --help` for the pairs this API takes';

const COMMENT_SCOPE_HELP =
  'scope to one comment — mandatory for a snippet, which is invisible without it';

/**
 * The entity's name in prose, derived from its `principal_type` rather than from the
 * command it is mounted under.
 *
 * Two reasons, and the second is the one that matters. The command names are not all
 * singular (`testhub runs`, `testhub cases`), so "comments on a runs" is what the
 * obvious approach produces. And a *derived* noun keeps the help comparable across
 * mounts: `test/crosscutting.test.ts` can compute exactly this string from the
 * principal type it already reads out of the tree, whereas a free-text noun supplied
 * per mount would be an unbounded difference the equality check could not normalise
 * (design D5.6).
 */
function nounOf(principalType: PrincipalType): string {
  return principalType.replace(/_/g, ' ');
}

function refHelp(noun: string): string {
  return `the ${noun} this applies to, in any form its own read commands accept (resolved to an id first)`;
}

/** Resolve the reference once, then hand the pair to `api/common.ts`. */
async function principalOf(
  ctx: Ctx,
  type: PrincipalType,
  ref: RefArg,
  noun: string,
  options: CrosscuttingOptions,
): Promise<Principal> {
  const id = await options.resolveId(ctx, requireFlag(ref, `<${noun}>`));
  if (id === '') {
    throw new UsageError(`could not resolve "${ref}" to a ${noun} id`, {
      hint: 'pass the id itself — the cross-object endpoints accept no identifier or short_id',
    });
  }
  return { type, id };
}

/**
 * `--target-type` is passed through as typed. It is **not** checked against
 * `RELATION_TARGETS`: that matrix is one tenant's observed behaviour, and refusing
 * locally would make a pair another tenant does accept unreachable (design D3.5).
 * The trailing help text and the rejection hint carry the knowledge instead.
 */
function targetTypeOf(value: string): PrincipalType {
  return requireFlag(value, '--target-type') as PrincipalType;
}

function scopeOf(flags: ScopeFlag): { comment_id?: string | undefined } {
  return flags.commentId === undefined ? {} : { comment_id: flags.commentId };
}

/** The `--yes` gate (design D8.1). No `--all` exists here, so D8.2 cannot apply. */
function confirm(flags: YesFlag, what: string, consequence: string): void {
  if (flags.yes === true) return;
  throw new UsageError(`refusing to delete ${what} without --yes`, {
    hint: `${consequence} — re-run with --yes, or with --yes --dry-run to see the request first`,
  });
}

/** A table cell must stay on one line; the API's text fields frequently do not. */
function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** One field of an embedded reference, without widening `Ref` for every mount. */
function idOf(ref: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = ref?.[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
