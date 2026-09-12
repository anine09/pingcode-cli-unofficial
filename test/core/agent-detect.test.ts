import { describe, expect, it } from 'vitest';
import { detectCurrentAgent } from '../../src/core/agent-detect';

/**
 * A port of `gh internal/agents/detect.go`. The ladder *order* is the
 * specification — the first rung that matches wins — so each test isolates one
 * rung and the last test asserts the ordering explicitly.
 */

describe('detectCurrentAgent', () => {
  it('returns undefined for an empty env', () => {
    expect(detectCurrentAgent({})).toBeUndefined();
  });

  it('returns undefined when only unrelated vars are set', () => {
    expect(detectCurrentAgent({ HOME: '/home/x', PATH: '/usr/bin', TERM: 'xterm' })).toBeUndefined();
  });

  it('ignores an empty-valued var', () => {
    expect(detectCurrentAgent({ CLAUDECODE: '', CLAUDE_CODE: '' })).toBeUndefined();
  });

  it('reports AI_AGENT verbatim, so unknown agents still get pre-selected', () => {
    expect(detectCurrentAgent({ AI_AGENT: 'some-future-agent' })).toBe('some-future-agent');
  });

  it('maps AGENT=amp to amp', () => {
    expect(detectCurrentAgent({ AGENT: 'amp' })).toBe('amp');
  });

  it('ignores AGENT set to anything but amp', () => {
    expect(detectCurrentAgent({ AGENT: 'claude-code' })).toBeUndefined();
  });

  it('maps any CODEX_* var to codex', () => {
    for (const name of ['CODEX_SANDBOX', 'CODEX_CI', 'CODEX_THREAD_ID']) {
      expect(detectCurrentAgent({ [name]: '1' })).toBe('codex');
    }
  });

  it('maps GEMINI_CLI to gemini-cli', () => {
    expect(detectCurrentAgent({ GEMINI_CLI: '1' })).toBe('gemini-cli');
  });

  it('maps COPILOT_CLI to github-copilot', () => {
    expect(detectCurrentAgent({ COPILOT_CLI: '1' })).toBe('github-copilot');
  });

  it('maps OPENCODE to opencode', () => {
    expect(detectCurrentAgent({ OPENCODE: '1' })).toBe('opencode');
  });

  it('maps ANTIGRAVITY_AGENT to antigravity', () => {
    expect(detectCurrentAgent({ ANTIGRAVITY_AGENT: '1' })).toBe('antigravity');
  });

  it('maps AUGMENT_AGENT to augment', () => {
    expect(detectCurrentAgent({ AUGMENT_AGENT: '1' })).toBe('augment');
  });

  it('maps REPL_ID to replit', () => {
    expect(detectCurrentAgent({ REPL_ID: 'abc123' })).toBe('replit');
  });

  it('maps any CLAUDE var to claude-code', () => {
    for (const name of ['CLAUDE_CODE_IS_COWORK', 'CLAUDECODE', 'CLAUDE_CODE']) {
      expect(detectCurrentAgent({ [name]: '1' })).toBe('claude-code');
    }
  });

  it('maps any CURSOR var to cursor', () => {
    for (const name of ['CURSOR_TRACE_ID', 'CURSOR_AGENT']) {
      expect(detectCurrentAgent({ [name]: '1' })).toBe('cursor');
    }
  });

  it('maps TERM_PROGRAM=kiro to kiro-cli', () => {
    expect(detectCurrentAgent({ TERM_PROGRAM: 'kiro' })).toBe('kiro-cli');
  });

  it('ignores TERM_PROGRAM set to another terminal', () => {
    expect(detectCurrentAgent({ TERM_PROGRAM: 'vscode' })).toBeUndefined();
  });

  it('maps GOOSE_PROVIDER to goose', () => {
    expect(detectCurrentAgent({ GOOSE_PROVIDER: 'anthropic' })).toBe('goose');
  });

  it('detects pi by its PATH segment', () => {
    expect(detectCurrentAgent({ PATH: '/usr/local/bin:/home/u/.pi/agent/bin' })).toBe('pi');
  });

  it('normalizes backslashes before matching the pi PATH segment', () => {
    expect(detectCurrentAgent({ PATH: 'C:\\Users\\u\\.pi\\agent\\bin' })).toBe('pi');
  });

  it('ignores a PATH entry that merely contains the segment mid-string', () => {
    expect(detectCurrentAgent({ PATH: '/opt/.pi/agent-not-really/bin' })).toBeUndefined();
  });

  it('treats a missing or empty PATH as no pi', () => {
    expect(detectCurrentAgent({})).toBeUndefined();
    expect(detectCurrentAgent({ PATH: '' })).toBeUndefined();
  });

  it('gives earlier rungs priority over later ones', () => {
    // AI_AGENT wins over everything, and AGENT=amp wins over CODEX_*.
    expect(detectCurrentAgent({ AI_AGENT: 'custom', CLAUDECODE: '1' })).toBe('custom');
    expect(detectCurrentAgent({ AGENT: 'amp', CODEX_CI: '1', GEMINI_CLI: '1' })).toBe('amp');
    expect(detectCurrentAgent({ COPILOT_CLI: '1', CURSOR_TRACE_ID: '1' })).toBe('github-copilot');
    // GOOSE_PROVIDER is last, so any other match beats it.
    expect(detectCurrentAgent({ GOOSE_PROVIDER: 'x', CURSOR_AGENT: '1' })).toBe('cursor');
  });

  it('falls through a non-matching AGENT to the next rung', () => {
    expect(detectCurrentAgent({ AGENT: 'claude-code', GEMINI_CLI: '1' })).toBe('gemini-cli');
  });
});
