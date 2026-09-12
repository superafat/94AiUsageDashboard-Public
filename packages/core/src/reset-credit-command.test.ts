import { describe, expect, it } from 'vitest';
import {
  parseResetCreditInventory,
  parseResetCreditCommand,
  parseResetCreditResult,
  selectActionableResetCredit,
  type ResetCreditInventory,
  type ResetCreditCommand,
  type ResetCreditResult,
  type ResetCreditResultCode,
} from './reset-credit-command';

describe('reset-credit-command (core)', () => {
  const validInventory: ResetCreditInventory = {
    version: 1,
    backendId: 'prod-backend',
    userId: 'user_123',
    targetDeviceId: 'mac_dev_456',
    accountId: 'acc_codex_789',
    observedAt: '2026-09-11T10:00:00.000Z',
    expiresAt: '2026-09-11T10:05:00.000Z',
    availableCount: 2,
    credits: [
      {
        creditId: 'credit_abc_1',
        expiresAt: '2026-09-15T00:00:00.000Z',
        status: 'available',
        resetType: 'codexRateLimits',
      },
      {
        creditId: 'credit_abc_2',
        expiresAt: '2026-09-18T00:00:00.000Z',
        status: 'available',
        resetType: 'codexRateLimits',
      },
    ],
  };

  const validCommand: ResetCreditCommand = {
    version: 1,
    commandId: 'cmd_001',
    idempotencyKey: 'idem_999',
    creditId: 'credit_abc_1',
    accountId: 'acc_codex_789',
    targetDeviceId: 'mac_dev_456',
    userId: 'user_123',
    backendId: 'prod-backend',
    requestedAt: '2026-09-11T10:01:00.000Z',
    expiresAt: '2026-09-11T10:06:00.000Z',
  };

  const validResult: ResetCreditResult = {
    version: 1,
    commandId: 'cmd_001',
    idempotencyKey: 'idem_999',
    creditId: 'credit_abc_1',
    accountId: 'acc_codex_789',
    targetDeviceId: 'mac_dev_456',
    userId: 'user_123',
    backendId: 'prod-backend',
    state: 'success',
    code: 'reset',
    executedAt: '2026-09-11T10:01:05.000Z',
    completedAt: '2026-09-11T10:01:06.000Z',
  };

  describe('parseResetCreditInventory', () => {
    it('parses a valid inventory object', () => {
      const parsed = parseResetCreditInventory(validInventory);
      expect(parsed).toEqual(validInventory);
    });

    it('accepts credits: null (details unavailable, count > 0)', () => {
      const input = { ...validInventory, credits: null, availableCount: 5 };
      const parsed = parseResetCreditInventory(input);
      expect(parsed.credits).toBeNull();
      expect(parsed.availableCount).toBe(5);
    });

    it('accepts availableCount > credits.length (capped backend list)', () => {
      const input = { ...validInventory, availableCount: 10 };
      const parsed = parseResetCreditInventory(input);
      expect(parsed.availableCount).toBe(10);
      expect(parsed.credits?.length).toBe(2);
    });

    it('rejects unexpected extra keys', () => {
      const input = { ...validInventory, extraForbiddenField: true };
      expect(() => parseResetCreditInventory(input)).toThrow('invalid_reset_credit_inventory');
    });

    it('rejects secret-shaped text in IDs', () => {
      const input = {
        ...validInventory,
        accountId: ['Bearer ', 'synthetic.jwt.payload.signature'].join(''),
      };
      expect(() => parseResetCreditInventory(input)).toThrow('invalid_reset_credit_inventory');

      const inputWithApiKey = {
        ...validInventory,
        userId: ['sk', 'ant', 'api03', 'synthetic-value'].join('-'),
      };
      expect(() => parseResetCreditInventory(inputWithApiKey)).toThrow('invalid_reset_credit_inventory');
    });

    it('rejects duplicate creditId in credits array', () => {
      const input = {
        ...validInventory,
        credits: [
          {
            creditId: 'dup_id',
            expiresAt: '2026-09-15T00:00:00.000Z',
            status: 'available',
            resetType: 'codexRateLimits',
          },
          {
            creditId: 'dup_id',
            expiresAt: '2026-09-18T00:00:00.000Z',
            status: 'available',
            resetType: 'codexRateLimits',
          },
        ],
      };
      expect(() => parseResetCreditInventory(input)).toThrow('invalid_reset_credit_inventory');
    });

    it('rejects invalid or non-existent calendar dates', () => {
      const input = { ...validInventory, observedAt: '2026-02-31T10:00:00.000Z' };
      expect(() => parseResetCreditInventory(input)).toThrow('invalid_reset_credit_inventory');
    });

    it('rejects negative or non-integer availableCount', () => {
      expect(() => parseResetCreditInventory({ ...validInventory, availableCount: -1 })).toThrow('invalid_reset_credit_inventory');
      expect(() => parseResetCreditInventory({ ...validInventory, availableCount: 1.5 })).toThrow('invalid_reset_credit_inventory');
    });

    it('rejects observedAt >= expiresAt', () => {
      expect(() =>
        parseResetCreditInventory({
          ...validInventory,
          observedAt: '2026-09-11T10:05:00.000Z',
          expiresAt: '2026-09-11T10:05:00.000Z',
        }),
      ).toThrow('invalid_reset_credit_inventory');
      expect(() =>
        parseResetCreditInventory({
          ...validInventory,
          observedAt: '2026-09-11T10:10:00.000Z',
          expiresAt: '2026-09-11T10:05:00.000Z',
        }),
      ).toThrow('invalid_reset_credit_inventory');
    });

    it('rejects availableCount=0 when available credits exist or availableCount < count of available credits', () => {
      expect(() =>
        parseResetCreditInventory({
          ...validInventory,
          availableCount: 0,
        }),
      ).toThrow('invalid_reset_credit_inventory');
      expect(() =>
        parseResetCreditInventory({
          ...validInventory,
          availableCount: 1, // but credits has 2 available items!
        }),
      ).toThrow('invalid_reset_credit_inventory');
    });

    it('rejects non-object or prototypes', () => {
      expect(() => parseResetCreditInventory(null)).toThrow('invalid_reset_credit_inventory');
      expect(() => parseResetCreditInventory('string')).toThrow('invalid_reset_credit_inventory');
      expect(() => parseResetCreditInventory(Object.create({ version: 1 }))).toThrow('invalid_reset_credit_inventory');
    });
  });

  describe('parseResetCreditCommand', () => {
    it('parses a valid command', () => {
      const parsed = parseResetCreditCommand(validCommand);
      expect(parsed).toEqual(validCommand);
    });

    it('rejects missing or empty creditId', () => {
      expect(() => parseResetCreditCommand({ ...validCommand, creditId: '' })).toThrow('invalid_reset_credit_command');
      const withoutCreditId = { ...validCommand };
      delete (withoutCreditId as Record<string, unknown>).creditId;
      expect(() => parseResetCreditCommand(withoutCreditId)).toThrow('invalid_reset_credit_command');
    });

    it('rejects extra fields', () => {
      expect(() => parseResetCreditCommand({ ...validCommand, injectedPrompt: 'do something' })).toThrow('invalid_reset_credit_command');
    });

    it('rejects secret-shaped tokens in command fields', () => {
      expect(() => parseResetCreditCommand({ ...validCommand, idempotencyKey: ['api_key=', 'AIza', 'synthetic-key-material'].join('') })).toThrow('invalid_reset_credit_command');
    });

    it('rejects requestedAt >= expiresAt', () => {
      expect(() =>
        parseResetCreditCommand({
          ...validCommand,
          requestedAt: '2026-09-11T10:06:00.000Z',
          expiresAt: '2026-09-11T10:06:00.000Z',
        }),
      ).toThrow('invalid_reset_credit_command');
    });

    it('Finding 7 RED: rejects email-shaped strings in identifiers', () => {
      const emailCmd = {
        ...validCommand,
        userId: ['user', 'example.com'].join('@'),
      };
      expect(() => parseResetCreditCommand(emailCmd)).toThrow('invalid_reset_credit_command');

      const emailAccountId = {
        ...validCommand,
        accountId: ['admin', '94ai.internal'].join('@'),
      };
      expect(() => parseResetCreditCommand(emailAccountId)).toThrow('invalid_reset_credit_command');
    });

    it('Finding 7 RED: rejects Authorization, Bearer, Basic, and Cookie prefixes/headers in identifiers', () => {
      expect(() =>
        parseResetCreditCommand({ ...validCommand, idempotencyKey: 'Authorization: Bearer secret' }),
      ).toThrow('invalid_reset_credit_command');
      expect(() =>
        parseResetCreditCommand({ ...validCommand, creditId: 'Bearer my-token-12345' }),
      ).toThrow('invalid_reset_credit_command');
      expect(() =>
        parseResetCreditCommand({ ...validCommand, backendId: 'Basic dXNlcjpwYXNz' }),
      ).toThrow('invalid_reset_credit_command');
      expect(() =>
        parseResetCreditCommand({ ...validCommand, targetDeviceId: 'Cookie: session=xyz' }),
      ).toThrow('invalid_reset_credit_command');
    });

    it('Finding 7 RED: rejects path separators in identifiers', () => {
      expect(() =>
        parseResetCreditCommand({ ...validCommand, commandId: '../../etc/passwd' }),
      ).toThrow('invalid_reset_credit_command');
    });

    it('rejects credential/auth/session-shaped identifiers including auth_, auth-, credential_, credential-, session=, session_, session-', () => {
      const forbiddenForms = [
        'auth_token123',
        'auth-session456',
        'credential_admin',
        'credential-key',
        'session=abc123xyz',
        'session_active',
        'session-persistent',
      ];
      for (const forbidden of forbiddenForms) {
        expect(() =>
          parseResetCreditCommand({ ...validCommand, idempotencyKey: forbidden }),
        ).toThrow('invalid_reset_credit_command');
        expect(() =>
          parseResetCreditCommand({ ...validCommand, creditId: forbidden }),
        ).toThrow('invalid_reset_credit_command');
        expect(() =>
          parseResetCreditCommand({ ...validCommand, accountId: forbidden }),
        ).toThrow('invalid_reset_credit_command');
      }
    });
  });

  describe('parseResetCreditResult', () => {
    it('parses valid success result', () => {
      const parsed = parseResetCreditResult(validResult);
      expect(parsed).toEqual(validResult);
    });

    it('rejects completedAt < executedAt', () => {
      expect(() =>
        parseResetCreditResult({
          ...validResult,
          executedAt: '2026-09-11T10:01:05.000Z',
          completedAt: '2026-09-11T10:01:04.000Z',
        }),
      ).toThrow('invalid_reset_credit_result');
    });

    it('accepts known result codes: reset, nothingToReset, noCredit, alreadyRedeemed', () => {
      for (const code of ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'] as const) {
        const state = code === 'reset' ? 'success' : 'failed';
        const parsed = parseResetCreditResult({ ...validResult, state, code });
        expect(parsed.code).toBe(code);
      }
    });

    it('rejects raw provider prose or unknown codes', () => {
      expect(() => parseResetCreditResult({ ...validResult, code: 'Error: Rate limit exceeded for model codex-5' as unknown as ResetCreditResultCode })).toThrow('invalid_reset_credit_result');
      expect(() => parseResetCreditResult({ ...validResult, code: 'Bearer token invalid' as unknown as ResetCreditResultCode })).toThrow('invalid_reset_credit_result');
    });
  });

  describe('selectActionableResetCredit', () => {
    const now = new Date('2026-09-11T10:00:00.000Z');

    it('returns null when credits is null (details unavailable)', () => {
      const inv: ResetCreditInventory = { ...validInventory, credits: null, availableCount: 3 };
      expect(selectActionableResetCredit(inv, now)).toBeNull();
    });

    it('returns null when credits is empty', () => {
      const inv: ResetCreditInventory = { ...validInventory, credits: [], availableCount: 0 };
      expect(selectActionableResetCredit(inv, now)).toBeNull();
    });

    it('returns null when accountId is empty', () => {
      const inv: ResetCreditInventory = { ...validInventory, accountId: '' };
      expect(selectActionableResetCredit(inv, now)).toBeNull();
    });

    it('selects the earliest-expiry available explicit credit', () => {
      const selected = selectActionableResetCredit(validInventory, now);
      expect(selected).not.toBeNull();
      expect(selected?.creditId).toBe('credit_abc_1');
    });

    it('ignores expired credits', () => {
      const inv: ResetCreditInventory = {
        ...validInventory,
        credits: [
          {
            creditId: 'expired_credit',
            expiresAt: '2026-09-10T00:00:00.000Z',
            status: 'available',
            resetType: 'codexRateLimits',
          },
          {
            creditId: 'future_credit',
            expiresAt: '2026-09-15T00:00:00.000Z',
            status: 'available',
            resetType: 'codexRateLimits',
          },
        ],
      };
      const selected = selectActionableResetCredit(inv, now);
      expect(selected?.creditId).toBe('future_credit');
    });

    it('returns null if all available credits are expired', () => {
      const inv: ResetCreditInventory = {
        ...validInventory,
        credits: [
          {
            creditId: 'expired_1',
            expiresAt: '2026-09-10T00:00:00.000Z',
            status: 'available',
            resetType: 'codexRateLimits',
          },
        ],
      };
      expect(selectActionableResetCredit(inv, now)).toBeNull();
    });

    it('does not select credits with non-available status or unknown resetType', () => {
      const inv: ResetCreditInventory = {
        ...validInventory,
        credits: [
          {
            creditId: 'redeeming_1',
            expiresAt: '2026-09-12T00:00:00.000Z',
            status: 'redeeming',
            resetType: 'codexRateLimits',
          },
          {
            creditId: 'unknown_type_1',
            expiresAt: '2026-09-13T00:00:00.000Z',
            status: 'available',
            resetType: 'unknown',
          },
        ],
      };
      expect(selectActionableResetCredit(inv, now)).toBeNull();
    });

    it('returns null when expiry ties make identity ambiguous', () => {
      const inv: ResetCreditInventory = {
        ...validInventory,
        credits: [
          {
            creditId: 'tie_1',
            expiresAt: '2026-09-15T00:00:00.000Z',
            status: 'available',
            resetType: 'codexRateLimits',
          },
          {
            creditId: 'tie_2',
            expiresAt: '2026-09-15T00:00:00.000Z',
            status: 'available',
            resetType: 'codexRateLimits',
          },
        ],
      };
      expect(selectActionableResetCredit(inv, now)).toBeNull();
    });

    it('known soonest-expiry credit outranks an unknown-expiry credit', () => {
      const inv: ResetCreditInventory = {
        ...validInventory,
        credits: [
          {
            creditId: 'unknown_expiry_1',
            expiresAt: null,
            status: 'available',
            resetType: 'codexRateLimits',
          },
          {
            creditId: 'known_expiry_1',
            expiresAt: '2026-09-15T00:00:00.000Z',
            status: 'available',
            resetType: 'codexRateLimits',
          },
        ],
      };
      const selected = selectActionableResetCredit(inv, now);
      expect(selected?.creditId).toBe('known_expiry_1');
    });

    it('selects single unknown-expiry credit if no known expiry credits exist', () => {
      const inv: ResetCreditInventory = {
        ...validInventory,
        credits: [
          {
            creditId: 'unknown_only',
            expiresAt: null,
            status: 'available',
            resetType: 'codexRateLimits',
          },
        ],
      };
      const selected = selectActionableResetCredit(inv, now);
      expect(selected?.creditId).toBe('unknown_only');
    });

    it('returns null if multiple unknown-expiry credits exist and tie makes them ambiguous', () => {
      const inv: ResetCreditInventory = {
        ...validInventory,
        credits: [
          {
            creditId: 'unknown_1',
            expiresAt: null,
            status: 'available',
            resetType: 'codexRateLimits',
          },
          {
            creditId: 'unknown_2',
            expiresAt: null,
            status: 'available',
            resetType: 'codexRateLimits',
          },
        ],
      };
      expect(selectActionableResetCredit(inv, now)).toBeNull();
    });

    it('returns null when inventory is not fresh: observedAt in future or expired (Blocker 7)', () => {
      const futureInv: ResetCreditInventory = {
        ...validInventory,
        observedAt: '2026-09-11T10:05:00.000Z',
        expiresAt: '2026-09-11T10:10:00.000Z',
      };
      expect(selectActionableResetCredit(futureInv, new Date('2026-09-11T10:00:00.000Z'))).toBeNull();

      const expiredInv: ResetCreditInventory = {
        ...validInventory,
        observedAt: '2026-09-11T09:00:00.000Z',
        expiresAt: '2026-09-11T09:59:59.000Z',
      };
      expect(selectActionableResetCredit(expiredInv, new Date('2026-09-11T10:00:00.000Z'))).toBeNull();
    });
  });
});
