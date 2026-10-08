import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import { registrationTypesFor } from '../../catalog/registration-types.js';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  files,
  tenantBankAccounts,
  tenantProfiles,
  tenantRegistrations,
  tenantSettings,
  tenants,
  type FilePurpose,
} from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor } from '../../platform/context.js';
import { decryptSecret, encryptSecret, fingerprint } from '../../shared/crypto.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { EXTENSION, sniffFile, UNSAFE_SVG } from '../files/file-validation.js';
import { presentProfileExtras, presentSettings } from './presenters.js';
import type {
  BrandingKindValue,
  CreateBankAccountBody,
  RegistrationBody,
  UpdateBankAccountBody,
} from './school-setup.schemas.js';

const KINDS: Record<
  BrandingKindValue,
  {
    purpose: FilePurpose;
    column: 'logoFileId' | 'bannerFileId' | 'documentHeaderFileId';
    maxBytes: number;
    label: string;
  }
> = {
  logo: { purpose: 'LOGO', column: 'logoFileId', maxBytes: 2 * 1024 * 1024, label: 'Logo' },
  banner: { purpose: 'BANNER', column: 'bannerFileId', maxBytes: 5 * 1024 * 1024, label: 'Banner' },
  'document-header': {
    purpose: 'DOCUMENT_HEADER',
    column: 'documentHeaderFileId',
    maxBytes: 5 * 1024 * 1024,
    label: 'Document header',
  },
};

export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

const sniffImage = sniffFile;

const maskNumber = (last4: string) => `XXXX${last4}`;

type BankRow = typeof tenantBankAccounts.$inferSelect;

function presentBank(r: BankRow) {
  return {
    id: r.id,
    label: r.label,
    account_holder: r.accountHolder,
    bank_name: r.bankName,
    branch_name: r.branchName,
    account_number_masked: maskNumber(r.accountLast4),
    ifsc: r.ifsc,
    account_type: r.accountType,
    upi_id: r.upiId,
    is_default: r.isDefault,
    archived: r.archivedAt !== null,
    version: r.version,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

export class SchoolSetupService {
  constructor(private readonly deps: Deps) {}

  private get key() {
    return this.deps.env.DATA_ENCRYPTION_KEY ?? this.deps.env.JWT_SECRET;
  }

  // ---------------------------------------------------------------------------
  // Files and branding (§12.4)
  // ---------------------------------------------------------------------------

  async uploadBranding(
    tenantId: string,
    kind: BrandingKindValue,
    input: { data: unknown; filename?: string },
    actor: Actor,
  ) {
    const spec = KINDS[kind];
    const data = input.data;
    if (!Buffer.isBuffer(data) || data.length === 0)
      throw new ValidationError(
        'Send the image as the request body with content-type image/png, image/jpeg, image/webp or image/svg+xml',
      );
    if (data.length > spec.maxBytes)
      throw new ValidationError(
        `${spec.label} must be smaller than ${spec.maxBytes / (1024 * 1024)} MB`,
      );
    const mime = sniffImage(data);
    if (!mime || !ALLOWED_IMAGE_TYPES.includes(mime))
      throw new ValidationError('Use a PNG, JPEG, WebP or SVG image');
    if (mime === 'image/svg+xml' && UNSAFE_SVG.test(data.toString('utf8')))
      throw new ValidationError(
        'This SVG contains scripts or external links and cannot be used. Export a plain SVG or use PNG.',
      );

    const fileId = uuidv7();
    const storageKey = `${tenantId}/${fileId}.${EXTENSION[mime]}`;
    await this.deps.storage.put(storageKey, data);
    try {
      return await this.deps.db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(tenantSettings)
          .where(eq(tenantSettings.tenantId, tenantId))
          .for('update');
        if (!before) throw new NotFoundError('School settings');
        await tx.insert(files).values({
          id: fileId,
          tenantId,
          purpose: spec.purpose,
          originalName: (input.filename ?? `${kind}.${EXTENSION[mime]}`).slice(0, 255),
          mimeType: mime,
          sizeBytes: data.length,
          checksumSha256: createHash('sha256').update(data).digest('hex'),
          storageDriver: this.deps.storage.driver,
          storageKey,
          uploadedBy: actor.userId,
        });
        const previous = before[spec.column];
        if (previous)
          await tx
            .update(files)
            .set({ supersededAt: this.deps.clock.now() })
            .where(and(eq(files.id, previous), eq(files.tenantId, tenantId)));
        await tx
          .update(tenantSettings)
          .set({ [spec.column]: fileId, version: before.version + 1, updatedBy: actor.userId })
          .where(eq(tenantSettings.tenantId, tenantId));
        await recordAudit(tx, actor, {
          tenantId,
          action: 'TENANT_BRANDING_UPDATED',
          entityType: 'tenant_settings',
          entityId: tenantId,
          before: { [kind]: previous },
          after: { [kind]: fileId, mime_type: mime, size_bytes: data.length },
        });
        const [after] = await tx
          .select()
          .from(tenantSettings)
          .where(eq(tenantSettings.tenantId, tenantId));
        return presentSettings(after!);
      });
    } catch (err) {
      await this.deps.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  async removeBranding(tenantId: string, kind: BrandingKindValue, actor: Actor) {
    const spec = KINDS[kind];
    return this.deps.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId))
        .for('update');
      if (!before) throw new NotFoundError('School settings');
      const previous = before[spec.column];
      if (previous) {
        await tx
          .update(files)
          .set({ supersededAt: this.deps.clock.now() })
          .where(and(eq(files.id, previous), eq(files.tenantId, tenantId)));
        await tx
          .update(tenantSettings)
          .set({ [spec.column]: null, version: before.version + 1, updatedBy: actor.userId })
          .where(eq(tenantSettings.tenantId, tenantId));
        await recordAudit(tx, actor, {
          tenantId,
          action: 'TENANT_BRANDING_REMOVED',
          entityType: 'tenant_settings',
          entityId: tenantId,
          before: { [kind]: previous },
          after: { [kind]: null },
        });
      }
      const [after] = await tx
        .select()
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
      return presentSettings(after!);
    });
  }

  /** Always filtered by tenant: another school's file id behaves as not found. */
  async readFile(tenantId: string, fileId: string) {
    const [row] = await this.deps.db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));
    if (!row) throw new NotFoundError('File');
    const data = await this.deps.storage.get(row.storageKey);
    if (!data) throw new NotFoundError('File');
    return { mime: row.mimeType, name: row.originalName, checksum: row.checksumSha256, data };
  }

  // ---------------------------------------------------------------------------
  // Bank accounts (§12.5)
  // ---------------------------------------------------------------------------

  async listBankAccounts(tenantId: string) {
    const rows = await this.deps.db
      .select()
      .from(tenantBankAccounts)
      .where(and(eq(tenantBankAccounts.tenantId, tenantId), isNull(tenantBankAccounts.archivedAt)))
      .orderBy(desc(tenantBankAccounts.isDefault), tenantBankAccounts.createdAt);
    return rows.map(presentBank);
  }

  private async getBank(tx: Executor, tenantId: string, id: string): Promise<BankRow> {
    const [row] = await tx
      .select()
      .from(tenantBankAccounts)
      .where(and(eq(tenantBankAccounts.id, id), eq(tenantBankAccounts.tenantId, tenantId)))
      .for('update');
    if (!row || row.archivedAt) throw new NotFoundError('Bank account');
    return row;
  }

  private async assertNotDuplicate(
    tx: Executor,
    tenantId: string,
    print: string,
    exceptId?: string,
  ) {
    const rows = await tx
      .select({ id: tenantBankAccounts.id })
      .from(tenantBankAccounts)
      .where(
        and(
          eq(tenantBankAccounts.tenantId, tenantId),
          eq(tenantBankAccounts.fingerprint, print),
          isNull(tenantBankAccounts.archivedAt),
        ),
      );
    if (rows.some((r) => r.id !== exceptId))
      throw new ConflictError(
        'DUPLICATE_RESOURCE',
        'This account number is already saved for the school',
        { field: 'account_number' },
      );
  }

  private printOf(number: string, ifsc: string) {
    return fingerprint(`${ifsc}:${number}`, this.key);
  }

  async createBankAccount(
    tenantId: string,
    input: z.infer<typeof CreateBankAccountBody>,
    actor: Actor,
  ) {
    return this.deps.db.transaction(async (tx) => {
      await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for('update');
      const print = this.printOf(input.account_number, input.ifsc);
      await this.assertNotDuplicate(tx, tenantId, print);
      const existing = await tx
        .select({ id: tenantBankAccounts.id })
        .from(tenantBankAccounts)
        .where(
          and(eq(tenantBankAccounts.tenantId, tenantId), isNull(tenantBankAccounts.archivedAt)),
        );
      const makeDefault = input.is_default || existing.length === 0;
      if (makeDefault)
        await tx
          .update(tenantBankAccounts)
          .set({ isDefault: false })
          .where(eq(tenantBankAccounts.tenantId, tenantId));
      const id = uuidv7();
      await tx.insert(tenantBankAccounts).values({
        id,
        tenantId,
        label: input.label ?? null,
        accountHolder: input.account_holder,
        bankName: input.bank_name,
        branchName: input.branch_name ?? null,
        accountNumberEnc: encryptSecret(input.account_number, this.key),
        accountLast4: input.account_number.slice(-4),
        fingerprint: print,
        ifsc: input.ifsc,
        accountType: input.account_type,
        upiId: input.upi_id ?? null,
        isDefault: makeDefault,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      const row = await this.getBank(tx, tenantId, id);
      await recordAudit(tx, actor, {
        tenantId,
        action: 'BANK_ACCOUNT_ADDED',
        entityType: 'tenant_bank_account',
        entityId: id,
        after: presentBank(row),
      });
      return presentBank(row);
    });
  }

  async updateBankAccount(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateBankAccountBody>,
    actor: Actor,
  ) {
    return this.deps.db.transaction(async (tx) => {
      const before = await this.getBank(tx, tenantId, id);
      if (before.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      const set: Partial<typeof tenantBankAccounts.$inferInsert> = {};
      if (input.label !== undefined) set.label = input.label || null;
      if (input.account_holder !== undefined) set.accountHolder = input.account_holder;
      if (input.bank_name !== undefined) set.bankName = input.bank_name;
      if (input.branch_name !== undefined) set.branchName = input.branch_name || null;
      if (input.account_type !== undefined) set.accountType = input.account_type;
      if (input.upi_id !== undefined) set.upiId = input.upi_id || null;
      const numberChanged = input.account_number !== undefined;
      if (input.ifsc !== undefined) set.ifsc = input.ifsc;
      if (numberChanged || input.ifsc !== undefined) {
        const number = input.account_number ?? decryptSecret(before.accountNumberEnc, this.key);
        const print = this.printOf(number, input.ifsc ?? before.ifsc);
        await this.assertNotDuplicate(tx, tenantId, print, id);
        set.fingerprint = print;
        if (numberChanged) {
          set.accountNumberEnc = encryptSecret(number, this.key);
          set.accountLast4 = number.slice(-4);
        }
      }
      await tx
        .update(tenantBankAccounts)
        .set({ ...set, version: before.version + 1, updatedBy: actor.userId })
        .where(eq(tenantBankAccounts.id, id));
      const after = await this.getBank(tx, tenantId, id);
      await recordAudit(tx, actor, {
        tenantId,
        action: 'BANK_ACCOUNT_UPDATED',
        entityType: 'tenant_bank_account',
        entityId: id,
        before: presentBank(before),
        after: { ...presentBank(after), account_number_changed: numberChanged },
      });
      return presentBank(after);
    });
  }

  async makeDefaultBankAccount(tenantId: string, id: string, actor: Actor) {
    return this.deps.db.transaction(async (tx) => {
      const before = await this.getBank(tx, tenantId, id);
      await tx
        .update(tenantBankAccounts)
        .set({ isDefault: false })
        .where(eq(tenantBankAccounts.tenantId, tenantId));
      await tx
        .update(tenantBankAccounts)
        .set({ isDefault: true, version: before.version + 1, updatedBy: actor.userId })
        .where(eq(tenantBankAccounts.id, id));
      const after = await this.getBank(tx, tenantId, id);
      await recordAudit(tx, actor, {
        tenantId,
        action: 'BANK_ACCOUNT_DEFAULT_CHANGED',
        entityType: 'tenant_bank_account',
        entityId: id,
        after: presentBank(after),
      });
      return presentBank(after);
    });
  }

  async archiveBankAccount(tenantId: string, id: string, reason: string, actor: Actor) {
    return this.deps.db.transaction(async (tx) => {
      const before = await this.getBank(tx, tenantId, id);
      if (before.isDefault) {
        const others = await tx
          .select({ id: tenantBankAccounts.id })
          .from(tenantBankAccounts)
          .where(
            and(eq(tenantBankAccounts.tenantId, tenantId), isNull(tenantBankAccounts.archivedAt)),
          );
        if (others.length > 1)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'Make another account the default before removing this one',
          );
      }
      await tx
        .update(tenantBankAccounts)
        .set({
          archivedAt: this.deps.clock.now(),
          isDefault: false,
          version: before.version + 1,
          updatedBy: actor.userId,
        })
        .where(eq(tenantBankAccounts.id, id));
      await recordAudit(tx, actor, {
        tenantId,
        action: 'BANK_ACCOUNT_ARCHIVED',
        entityType: 'tenant_bank_account',
        entityId: id,
        before: presentBank(before),
        reason,
      });
      return { id, archived: true };
    });
  }

  /** The only path that returns a full number. Every call is audited with the reason. */
  async revealBankAccount(tenantId: string, id: string, reason: string, actor: Actor) {
    return this.deps.db.transaction(async (tx) => {
      const row = await this.getBank(tx, tenantId, id);
      await recordAudit(tx, actor, {
        tenantId,
        action: 'BANK_ACCOUNT_REVEALED',
        entityType: 'tenant_bank_account',
        entityId: id,
        after: { account_number_masked: maskNumber(row.accountLast4) },
        reason,
      });
      return { id, account_number: decryptSecret(row.accountNumberEnc, this.key) };
    });
  }

  // ---------------------------------------------------------------------------
  // Registration details (§12.6)
  // ---------------------------------------------------------------------------

  private async country(tenantId: string, ex: Executor = this.deps.db) {
    const [row] = await ex
      .select({ country: tenants.country })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!row) throw new NotFoundError('School');
    return row.country;
  }

  async listRegistrations(tenantId: string) {
    const types = registrationTypesFor(await this.country(tenantId));
    const rows = await this.deps.db
      .select()
      .from(tenantRegistrations)
      .where(eq(tenantRegistrations.tenantId, tenantId));
    return {
      types: types.map((t) => ({
        code: t.code,
        label: t.label,
        hint: t.hint,
        example: t.example ?? null,
        has_dates: t.dates ?? false,
        has_authority: t.authority ?? false,
        max_length: t.maxLength,
      })),
      items: rows.map(presentRegistration),
    };
  }

  async setRegistration(
    tenantId: string,
    typeCode: string,
    input: z.infer<typeof RegistrationBody>,
    actor: Actor,
  ) {
    const type = registrationTypesFor(await this.country(tenantId)).find(
      (t) => t.code === typeCode,
    );
    if (!type) throw new NotFoundError('Registration type');
    const value = type.pattern ? input.value.toUpperCase().replace(/\s+/g, '') : input.value;
    if (value.length > type.maxLength)
      throw new ValidationError(`${type.label} is too long`, { field: 'value' });
    if (type.pattern && !type.pattern.test(value))
      throw new ValidationError(`${type.label} is not valid. ${type.hint}`, { field: 'value' });
    const issuedOn = type.dates ? (input.issued_on ?? null) : null;
    const validUntil = type.dates ? (input.valid_until ?? null) : null;
    if (issuedOn && validUntil && validUntil < issuedOn)
      throw new ValidationError('Valid-until date must be after the issue date', {
        field: 'valid_until',
      });
    const authority = type.authority ? (input.authority ?? null) : null;

    return this.deps.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(tenantRegistrations)
        .where(
          and(
            eq(tenantRegistrations.tenantId, tenantId),
            eq(tenantRegistrations.typeCode, typeCode),
          ),
        );
      await tx
        .insert(tenantRegistrations)
        .values({
          tenantId,
          typeCode,
          value,
          issuedOn,
          validUntil,
          authority,
          updatedBy: actor.userId,
        })
        .onDuplicateKeyUpdate({
          set: { value, issuedOn, validUntil, authority, updatedBy: actor.userId },
        });
      const [after] = await tx
        .select()
        .from(tenantRegistrations)
        .where(
          and(
            eq(tenantRegistrations.tenantId, tenantId),
            eq(tenantRegistrations.typeCode, typeCode),
          ),
        );
      await recordAudit(tx, actor, {
        tenantId,
        action: before ? 'REGISTRATION_UPDATED' : 'REGISTRATION_ADDED',
        entityType: 'tenant_registration',
        entityId: after!.id,
        before: before ? presentRegistration(before) : null,
        after: presentRegistration(after!),
      });
      return presentRegistration(after!);
    });
  }

  async removeRegistration(tenantId: string, typeCode: string, actor: Actor) {
    await this.deps.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(tenantRegistrations)
        .where(
          and(
            eq(tenantRegistrations.tenantId, tenantId),
            eq(tenantRegistrations.typeCode, typeCode),
          ),
        );
      if (!before) throw new NotFoundError('Registration');
      await tx.delete(tenantRegistrations).where(eq(tenantRegistrations.id, before.id));
      await recordAudit(tx, actor, {
        tenantId,
        action: 'REGISTRATION_REMOVED',
        entityType: 'tenant_registration',
        entityId: before.id,
        before: presentRegistration(before),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Completeness and document branding
  // ---------------------------------------------------------------------------

  /** Counts only; leaks no values, so any profile reader may see it. */
  async completeness(tenantId: string) {
    const [tenant] = await this.deps.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new NotFoundError('School');
    const [profile] = await this.deps.db
      .select()
      .from(tenantProfiles)
      .where(eq(tenantProfiles.tenantId, tenantId));
    const [settings] = await this.deps.db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const banks = await this.deps.db
      .select({ id: tenantBankAccounts.id, isDefault: tenantBankAccounts.isDefault })
      .from(tenantBankAccounts)
      .where(and(eq(tenantBankAccounts.tenantId, tenantId), isNull(tenantBankAccounts.archivedAt)));
    const regs = await this.deps.db
      .select({ typeCode: tenantRegistrations.typeCode })
      .from(tenantRegistrations)
      .where(eq(tenantRegistrations.tenantId, tenantId));
    const has = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '';
    const regSet = new Set(regs.map((r) => r.typeCode));
    const sections: { code: string; label: string; checks: [string, boolean][] }[] = [
      {
        code: 'profile',
        label: 'School profile',
        checks: [
          ['School type', has(tenant.schoolType)],
          ['Affiliation board', has(profile?.affiliationBoard)],
          ['Affiliation number', has(profile?.affiliationNumber)],
          ['Year established', has(profile?.establishedYear)],
          ['Medium of instruction', has(profile?.mediumOfInstruction)],
        ],
      },
      {
        code: 'contact',
        label: 'Contact and address',
        checks: [
          ['Email', has(tenant.contactEmail)],
          ['Phone', has(tenant.contactPhone)],
          ['Address', has(tenant.addressLine1)],
          ['City', has(tenant.city)],
          ['State', has(tenant.state)],
          ['Postal code', has(tenant.postalCode)],
          ['Contact person', has(profile?.contactPersonName)],
        ],
      },
      {
        code: 'branding',
        label: 'Logo and branding',
        checks: [
          ['Logo', has(settings?.logoFileId)],
          ['Brand colour', has(settings?.brandPrimaryColor)],
          ['Document footer', has(profile?.documentFooter)],
        ],
      },
      {
        code: 'bank',
        label: 'Bank details',
        checks: [['Default bank account', banks.some((b) => b.isDefault)]],
      },
      {
        code: 'registration',
        label: 'Registration details',
        checks: [
          ['School registration number', regSet.has('SCHOOL_REGISTRATION')],
          ['PAN', regSet.has('PAN')],
        ],
      },
    ];
    let done = 0;
    let total = 0;
    const out = sections.map((s) => {
      const d = s.checks.filter(([, ok]) => ok).length;
      done += d;
      total += s.checks.length;
      return {
        code: s.code,
        label: s.label,
        done: d,
        total: s.checks.length,
        missing: s.checks.filter(([, ok]) => !ok).map(([l]) => l),
      };
    });
    return { percent: Math.round((done / total) * 100), sections: out };
  }

  /** Everything a printed document (receipt, certificate, letter) needs in one call. Bank number stays masked. */
  async documentBranding(tenantId: string) {
    const [tenant] = await this.deps.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new NotFoundError('School');
    const [profile] = await this.deps.db
      .select()
      .from(tenantProfiles)
      .where(eq(tenantProfiles.tenantId, tenantId));
    const [settings] = await this.deps.db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const [bank] = await this.deps.db
      .select()
      .from(tenantBankAccounts)
      .where(
        and(
          eq(tenantBankAccounts.tenantId, tenantId),
          eq(tenantBankAccounts.isDefault, true),
          isNull(tenantBankAccounts.archivedAt),
        ),
      );
    const regs = await this.deps.db
      .select()
      .from(tenantRegistrations)
      .where(eq(tenantRegistrations.tenantId, tenantId));
    return {
      school_name: tenant.name,
      short_name: tenant.shortName,
      address: {
        line1: tenant.addressLine1,
        line2: tenant.addressLine2,
        city: tenant.city,
        state: tenant.state,
        postal_code: tenant.postalCode,
        country: tenant.country,
      },
      phone: tenant.contactPhone,
      email: tenant.contactEmail,
      logo_file_id: settings?.logoFileId ?? null,
      header_file_id: settings?.documentHeaderFileId ?? null,
      primary_color: settings?.brandPrimaryColor ?? null,
      footer_text: profile?.documentFooter ?? null,
      extras: presentProfileExtras(profile),
      bank: bank ? presentBank(bank) : null,
      registrations: Object.fromEntries(regs.map((r) => [r.typeCode, r.value])),
    };
  }
}

function presentRegistration(r: typeof tenantRegistrations.$inferSelect) {
  return {
    type: r.typeCode,
    value: r.value,
    issued_on: r.issuedOn,
    valid_until: r.validUntil,
    authority: r.authority,
    updated_at: r.updatedAt.toISOString(),
  };
}
