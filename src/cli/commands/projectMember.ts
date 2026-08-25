import type { Command } from 'commander';
import {
  addProjectMember,
  getProjectMember,
  iterateProjectMembers,
  listProjectMembers,
  type AddProjectMemberInput,
} from '../../api/projects';
import type { Ctx } from '../../core/context';
import { UsageError } from '../../core/errors';
import { resolveProject, resolveUser, type ResolveResult } from '../../core/metadata';
import { collect } from '../../core/paginate';
import type { ProjectMember } from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
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
  runWrite,
  type PagingFlags,
  type ResolvedWrite,
} from './common';

/**
 * `pingcode project member …` — 项目成员, live-verified 2026-08-04 (design D16).
 *
 * Three leaves, not four. `DELETE /v1/pjm/projects/{id}/members/{member_id}` **does**
 * exist upstream and is deliberately **not** wrapped in a leaf: the endpoint budget this
 * child owns is twenty, the generic layer already reaches it
 * (`pingcode api DELETE /v1/pjm/projects/<p>/members/<user> --yes`), and a membership is
 * the cheapest thing in the API to recreate — one `member add`. The absence is asserted
 * by `test/help/project.test.ts` so it does not get "completed" by accident, and it is
 * documented here and in `modules/pjm.md` so nobody has to discover it.
 *
 * Group-wide facts, so no leaf repeats them:
 *
 *  - a membership row's **`id` is the user (or group) id**, and the row carries no
 *    top-level name — the display name lives inside `user`. So `member get` takes the
 *    user reference, not some separate membership id. Same shape as ship's product
 *    members (ship §3.6).
 *  - `role_id` defaults to **普通成员**. The three roles are organisation-level:
 *    `pingcode api GET /v1/directory/roles`.
 *  - a project's **assignee (负责人) need not be a member**, and setting one does not add
 *    them — verified live, and worth knowing because it is the opposite of what a ship
 *    product enforces.
 */

type ProjectFlag = { project: string };
type ListFlags = PagingFlags & ProjectFlag;
type AddFlags = ProjectFlag & {
  user?: string | undefined;
  groupId?: string | undefined;
  roleId?: string | undefined;
};

const PROJECT_HELP = 'project name or id';

const MEMBER_COLUMNS: Column<ProjectMember>[] = [
  { header: 'ID', value: (member) => member.id },
  { header: 'KIND', value: (member) => member.type ?? '' },
  { header: 'NAME', value: (member) => memberName(member), flex: true },
  { header: 'ROLE', value: (member) => refName(member.role) },
];

export function registerMemberCommands(parent: Command): void {
  const group = parent
    .command('member')
    .description('项目成员 members of a project (scopes pcp:read:pjm:project / pcp:write:pjm:project)');

  group.addHelpText(
    'after',
    '\nA membership is addressed by the USER id, not by a separate membership id — that is\n' +
      'what the API returns as the row id, so `member get <user>` is the same reference\n' +
      '`member add --user` took.\n' +
      'There is no `member remove` leaf: the endpoint exists, and the generic layer reaches\n' +
      'it — pingcode api DELETE /v1/pjm/projects/<project>/members/<user> --yes\n' +
      'It is not a refined leaf because a membership is trivially recreatable with\n' +
      '`member add`, and this command group is capped at the endpoints it was scoped for.\n' +
      "Note the project's 负责人 (owner) is unrelated to membership: it can be someone\n" +
      'who is not a member, and setting it does not add them.\n' +
      'Work-item assignees are different: they MUST be project members — the CLI blocks\n' +
      'assignment of non-members, because a non-member cannot see the card.\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list the members of a project (user memberships are the only valid --assignee candidates)')
        .requiredOption('--project <name|id>', PROJECT_HELP),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const project = await resolveProject(ctx, flags.project);
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateProjectMembers(ctx, project.id, {
          pageSize: paging.pageSize,
          limit: paging.limit,
        }),
      );
      printCollection(values, MEMBER_COLUMNS, modeOf(ctx), { all: true });
      return;
    }

    const page = await listProjectMembers(ctx, project.id, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, MEMBER_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one membership, addressed by the user it belongs to')
      .argument('<user>', 'user display name, username, email or id')
      .requiredOption('--project <name|id>', PROJECT_HELP),
    { hidden: true },
  ).action(async (target: string, flags: ProjectFlag, command: Command) => {
    const { ctx } = contextFor(command);
    const project = await resolveProject(ctx, flags.project);
    const user = await resolveUser(ctx, requireFlag(target, '<user>'));
    printMember(await getProjectMember(ctx, project.id, user.id), ctx);
  });

  addGlobalOptions(
    group
      .command('add')
      .description('add a user or a team to a project')
      .requiredOption('--project <name|id>', PROJECT_HELP)
      .option('--user <name|id>', 'user: display name, username, email or id')
      .option(
        '--group-id <id>',
        'team (user group) id instead of a user — ids only, from `pingcode api GET /v1/directory/groups`',
      )
      .option(
        '--role-id <id>',
        'role id from `pingcode api GET /v1/directory/roles`; omitted, the API picks 普通成员',
      ),
    { hidden: true },
  ).action(async (flags: AddFlags, command: Command) => {
    await runAdd(flags, command);
  });
}

async function runAdd(flags: AddFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const hasUser = flags.user !== undefined && flags.user.trim() !== '';
  const hasGroup = flags.groupId !== undefined && flags.groupId.trim() !== '';

  if (hasUser && hasGroup) {
    throw new UsageError('--user and --group-id are mutually exclusive', {
      hint: 'a membership names exactly one principal, either a user or a team',
    });
  }
  if (!hasUser && !hasGroup) {
    throw new UsageError('member add requires --user <name|id> or --group-id <id>');
  }

  const member = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<{ projectId: string; input: AddProjectMemberInput }>> => {
      const project = await resolveProject(attemptCtx, flags.project);
      const resolutions: ResolveResult[] = [project];

      let principal: { id: string; type: string };
      if (hasGroup) {
        // No `--group <name>`: teams live in `/v1/directory/groups`, which is outside
        // this command group's endpoint set and has no resolver row, so offering a name
        // flag would mean guessing at a lookup this child does not own.
        principal = { id: requireFlag(flags.groupId, '--group-id'), type: 'user_group' };
      } else {
        const user = await resolveUser(attemptCtx, requireFlag(flags.user, '--user'));
        resolutions.push(user);
        principal = { id: user.id, type: 'user' };
      }

      return {
        resolutions,
        value: {
          projectId: project.id,
          input: {
            member: principal,
            ...(flags.roleId === undefined ? {} : { role_id: flags.roleId }),
          },
        },
      };
    },
    async (attemptCtx, { projectId, input }) => await addProjectMember(attemptCtx, projectId, input),
  );

  printMember(member, ctx, 'added');
}

function memberName(member: ProjectMember): string {
  const user = member.user;
  if (user !== undefined) {
    const display = user.display_name;
    const name = typeof display === 'string' && display !== '' ? display : user.name;
    return name ?? user.id;
  }
  return refName(member.user_group);
}

function printMember(member: ProjectMember, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    member,
    [
      ['id', member.id],
      ['kind', member.type ?? ''],
      ['name', memberName(member)],
      ['role', refName(member.role)],
      ['project', refName(member.project)],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${memberName(member)}`));
  }
}
