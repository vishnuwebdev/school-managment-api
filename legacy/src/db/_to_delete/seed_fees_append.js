
// Fees & Payments (designs/Teacher feature UI mockup/Fees and
// Payments.dc.html, 9 screens). Seeds a real, worked example of a term's
// worth of collections: a published fee structure (per-phase heads, one
// of them Early-years-only so an unused head is genuinely on record, not
// fabricated), a billing schedule with two terms already due and a third
// not yet billed, invoices raised for every active student against both
// due terms, a real spread of payment outcomes (fully paid & reconciled,
// part-paid, untouched), a real sibling discount (two existing active
// students are given a shared "guardian" contact -- see the comment
// below), a real payment plan, real escalation history, and a real bank
// reconciliation queue with Exact/Likely/None lines side by side.
//
// Reuses the module's own service.js functions throughout (raiseInvoices-
// ForTerm, recordPayment, matchBankLine, setupPaymentPlan, getInvoiceView,
// getStudentBalance) rather than re-deriving the logic here, so the seed
// data is produced by exactly the same code path the API itself runs --
// the same principle as seedAttendance driving real attendance.upsertMany
// calls instead of writing history rows by hand.
async function seedFees(tenantId) {
  if ((await db.feeStructures.list(tenantId)).length > 0) return; // idempotent, same as the other seed*() functions

  const admin = await db.users.findByEmail('admin@brightfuture.edu');
  const subAdmin = await db.users.findByEmail('subadmin@brightfuture.edu');
  const adminId = admin?.id || null;
  const subAdminId = subAdmin?.id || null;

  // Sibling discount (rules.siblingDiscountPercent, applied automatically
  // by raiseInvoicesForTerm/isYoungerSibling) needs two active students
  // who genuinely share a guardian contact to have anything real to show.
  // No two seeded students share a surname, so rather than inventing a
  // 13th student just to demonstrate this, two existing active students
  // -- Arjun Gupta (Class 7) and Karan Malhotra (Class 8), a plausible
  // one-grade age gap -- are given a shared secondary "guardian" contact
  // (a shared family friend/emergency contact), a field every seeded
  // student already has present but empty. Nothing on either student's
  // real father/mother contact fields is touched.
  const allStudents = await db.students.list(tenantId, {});
  const byAdmission = Object.fromEntries(allStudents.map((s) => [s.admissionNumber, s]));
  const arjun = byAdmission['BFS005'];
  const karan = byAdmission['BFS009'];
  if (arjun && karan) {
    const sharedGuardian = { name: 'Meena Iyer (family friend, listed on both files)', phone: '+91 99887 76655', email: '' };
    await db.students.update(tenantId, arjun.id, { guardians: { ...arjun.guardians, guardian: sharedGuardian } });
    await db.students.update(tenantId, karan.id, { guardians: { ...karan.guardians, guardian: sharedGuardian } });
  }

  // Fee structure -- one published version. Tuition/Books/Sports price
  // every phase actually in use; Aftercare is Early-years-only and priced
  // for it, but genuinely unbilled this run since no active student is in
  // Nursery/LKG/UKG yet -- an honest "defined, not yet needed" head,
  // exactly like Classes & Sections' six unplanned curriculum subjects.
  const draft = await db.feeStructures.createDraft(tenantId, { createdBy: adminId });
  const heads = await db.feeStructureHeads.replaceForStructure(tenantId, draft.id, [
    { name: 'Tuition', type: 'Core', cycle: 'Per term', amountEarlyYears: 8500, amountPrimary: 9800, amountSecondary: 11500, appliesTo: 'All learners' },
    { name: 'Books & Materials', type: 'Core', cycle: 'Per term', amountEarlyYears: 650, amountPrimary: 850, amountSecondary: 1100, appliesTo: 'All learners' },
    { name: 'Sports & Extra-mural', type: 'Optional', cycle: 'Per term', amountEarlyYears: 450, amountPrimary: 600, amountSecondary: 750, appliesTo: 'All learners' },
    { name: 'Aftercare', type: 'Optional', cycle: 'Per term', amountEarlyYears: 1200, amountPrimary: null, amountSecondary: null, appliesTo: 'Early years only' },
  ]);
  await db.feeStructures.publish(tenantId, draft.id);
  await db.audit.record({ event: 'fees.structurePublished', actorId: adminId, target: draft.id, tenantId, summary: { version: 1, heads: heads.length } });

  // Billing schedule -- Term 1 and Term 2 already due (so invoices raised
  // below have real ageing to show across the whole status range, up to
  // and including the "handover" escalation tier), Term 3 due in
  // December and deliberately not yet billed, matching how every other
  // module's "batch" action here is manual and admin-triggered.
  const schedule = [
    { termLabel: 'Term 1', dueDate: '2026-05-15', sharePercent: 40, note: 'Due at the start of Term 1' },
    { termLabel: 'Term 2', dueDate: '2026-08-15', sharePercent: 35, note: 'Due at the start of Term 2' },
    { termLabel: 'Term 3', dueDate: '2026-12-15', sharePercent: 25, note: 'Due at the start of Term 3 -- not yet billed' },
  ];
  for (let i = 0; i < schedule.length; i += 1) {
    await db.feeBillingSchedule.create({ tenantId, orderIndex: i, ...schedule[i] });
  }

  // Raise Term 1, then Term 2 -- both real calls to the same endpoint an
  // admin would use, including the real sibling discount and the real
  // interest true-up run immediately after each (see accrueInterest's
  // header: every overdue invoice, whether or not it's about to be paid
  // off a moment later in this script, genuinely owes that interest as
  // of today -- exactly as it would for a real school digitising an
  // existing arrears book for the first time).
  await raiseInvoicesForTerm(tenantId, 'Term 1', adminId);
  await raiseInvoicesForTerm(tenantId, 'Term 2', adminId);

  const invoiceFor = async (studentId, termLabel) => (await db.feeInvoices.list(tenantId, { studentId })).find((i) => i.termLabel === termLabel);

  // amount: 'full' | 'part' (55%) | undefined (left unpaid). bank: true
  // records a matching bank-statement line so the payment reconciles to
  // Exact and gets confirmed, exactly like a real EFT landing in the
  // account; omitted, the payment sits real but unconfirmed -- the same
  // "unreconciled value" the overview/reconciliation screens are built to
  // surface.
  const plan = [
    { adm: 'BFS001', name: 'Sharma', term1: 'full', term2: 'full', method: 'EFT', bank: true },
    { adm: 'BFS002', name: 'Patel', term1: 'full', term2: undefined, method: 'EFT', bank: false },
    { adm: 'BFS003', name: 'Singh', term1: 'part', term2: undefined, method: 'Card', bank: false },
    { adm: 'BFS004', name: 'Nair', term1: undefined, term2: undefined },
    { adm: 'BFS005', name: 'Gupta', term1: 'part', term2: 'full', method: 'Debit order', bank: true }, // Arjun -- sibling discount on both invoices
    { adm: 'BFS006', name: 'Khan', term1: 'full', term2: 'full', method: 'EFT', bank: true },
    { adm: 'BFS007', name: 'Verma', term1: undefined, term2: undefined }, // -> payment plan below
    { adm: 'BFS008', name: 'Reddy', term1: undefined, term2: undefined }, // -> escalation history below
    { adm: 'BFS009', name: 'Malhotra', term1: undefined, term2: undefined }, // Karan -- no discount, worst arrears
    { adm: 'BFS010', name: 'Roy', term1: 'full', term2: 'part', method: 'Cash', bank: false },
  ];

  let bankRefSeq = 1;
  for (const row of plan) {
    const student = byAdmission[row.adm];
    if (!student) continue;
    for (const [termLabel, mode] of [['Term 1', row.term1], ['Term 2', row.term2]]) {
      if (!mode) continue;
      const invoice = await invoiceFor(student.id, termLabel);
      if (!invoice) continue;
      const view = await getInvoiceView(tenantId, invoice);
      if (view.balance <= 0) continue;
      const amountReceived = mode === 'full' ? view.balance : Number((view.balance * 0.55).toFixed(2));
      const bankReference = `${row.name.toUpperCase()}${bankRefSeq}`;
      bankRefSeq += 1;
      const { payment } = await recordPayment(tenantId, adminId, {
        studentId: student.id, amountReceived, dateReceived: invoice.dueDate < todayStr() ? invoice.dueDate : todayStr(),
        method: row.method || 'EFT', bankReference, allocations: [{ invoiceId: invoice.id, amount: amountReceived }],
      });
      if (row.bank) {
        const line = await db.bankStatementLines.create({
          tenantId, date: payment.dateReceived, reference: bankReference, amount: amountReceived,
          matchedPaymentId: null, confidence: 'None', reviewedBy: null, reviewedAt: null, createdBy: adminId,
        });
        await matchBankLine(tenantId, line);
      }
    }
  }

  // Two more bank lines that don't cleanly resolve -- a same-amount-only
  // "Likely" match still waiting on human review, and a genuinely
  // unidentified deposit ("None") that fee_settings' unmatchedAlert rule
  // exists to chase.
  const diyaTerm1 = await invoiceFor(byAdmission['BFS002'].id, 'Term 1');
  const diyaView = diyaTerm1 ? await getInvoiceView(tenantId, diyaTerm1) : null;
  if (diyaView && diyaView.paidAllocated > 0) {
    const likelyLine = await db.bankStatementLines.create({
      tenantId, date: todayStr(), reference: 'EFT REF UNKNOWN 4471', amount: diyaView.paidAllocated,
      matchedPaymentId: null, confidence: 'None', reviewedBy: null, reviewedAt: null, createdBy: adminId,
    });
    await matchBankLine(tenantId, likelyLine); // same amount as Diya's real unconfirmed payment, different reference -- resolves to "Likely"
  }
  await db.bankStatementLines.create({
    tenantId, date: todayStr(), reference: 'MOBILE DEPOSIT 9021', amount: 500,
    matchedPaymentId: null, confidence: 'None', reviewedBy: null, reviewedAt: null, createdBy: adminId,
  });

  // Payment plan (screen 7) for Ishaan Verma -- a real record against his
  // genuine outstanding balance, three instalments starting a few days
  // out so it reads as "On track" rather than already broken.
  const ishaan = byAdmission['BFS007'];
  if (ishaan) {
    const { owed } = await getStudentBalance(tenantId, ishaan.id);
    if (owed > 0) {
      const startDate = new Date(); startDate.setUTCDate(startDate.getUTCDate() + 5);
      await setupPaymentPlan(tenantId, adminId, ishaan.id, { instalmentCount: 3, startDate: startDate.toISOString().slice(0, 10) });
    }
  }

  // Escalation history (screen 7) -- Ananya already has one reminder on
  // record from three weeks ago; Karan (the older, undiscounted sibling,
  // and the most overdue learner seeded) has both a first and a second
  // reminder already logged, so re-running the ladder finds him queued
  // for the next real step rather than starting cold.
  const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString(); };
  const ananya = byAdmission['BFS008'];
  if (ananya) {
    await db.feeEscalationEvents.create({ tenantId, studentId: ananya.id, invoiceId: null, step: 'first_reminder', note: '', createdBy: adminId, createdAt: daysAgo(21) });
  }
  if (karan) {
    await db.feeEscalationEvents.create({ tenantId, studentId: karan.id, invoiceId: null, step: 'first_reminder', note: '', createdBy: adminId, createdAt: daysAgo(55) });
    await db.feeEscalationEvents.create({ tenantId, studentId: karan.id, invoiceId: null, step: 'second_reminder', note: '', createdBy: adminId, createdAt: daysAgo(25) });
  }

  // Disbursements (screen 8) -- one still awaiting approval, one already
  // approved by a second person (above the two-person threshold, so
  // requester and approver are genuinely different accounts) but not yet
  // paid, and one fully paid with a real proof-of-payment document
  // attached through the same storage adapter seedStaff's documents use.
  await db.feeDisbursements.create({
    tenantId, reference: 'PAY-2026-301', date: todayStr(), payeeName: 'Cape Print & Stationery', reason: 'Term 3 exam booklet printing',
    amount: 2850, method: 'EFT', state: 'Awaiting approval', proofDocumentId: null, requestedBy: adminId, approvedBy: null, decidedAt: null,
  });

  const bigDisbursement = await db.feeDisbursements.create({
    tenantId, reference: 'PAY-2026-302', date: todayStr(), payeeName: 'GreenTurf Sports Surfaces', reason: 'Resurfacing the netball court',
    amount: 18500, method: 'EFT', state: 'Awaiting approval', proofDocumentId: null, requestedBy: subAdminId || adminId, approvedBy: null, decidedAt: null,
  });
  await db.feeDisbursements.update(tenantId, bigDisbursement.id, { state: 'Approved', approvedBy: adminId, decidedAt: new Date().toISOString() });
  await db.audit.record({ event: 'fees.disbursementApproved', actorId: adminId, target: bigDisbursement.id, tenantId, summary: { amount: 18500 } });

  const paidDisbursement = await db.feeDisbursements.create({
    tenantId, reference: 'PAY-2026-303', date: daysAgo(6).slice(0, 10), payeeName: 'City Bus Services', reason: 'Term 2 transport subsidy top-up',
    amount: 4200, method: 'EFT', state: 'Approved', proofDocumentId: null, requestedBy: adminId, approvedBy: adminId, decidedAt: daysAgo(5),
  });
  const proofBuffer = Buffer.from('Placeholder for City Bus Services EFT proof of payment (seed data).', 'utf-8');
  const storageKey = await storage.save({ tenantId, entityType: 'fees', entityId: paidDisbursement.id, fileName: 'PAY-2026-303-proof.pdf', buffer: proofBuffer });
  const proofDoc = await db.documents.create({
    tenantId, entityType: 'fees', entityId: paidDisbursement.id, documentType: 'Proof of payment',
    fileName: 'PAY-2026-303-proof.pdf', storageKey, mimeType: 'application/pdf', sizeBytes: proofBuffer.length, uploadedBy: adminId, expiryDate: null,
  });
  await db.feeDisbursements.update(tenantId, paidDisbursement.id, { proofDocumentId: proofDoc.id, state: 'Paid' });
  await db.audit.record({ event: 'fees.disbursementPaid', actorId: adminId, target: paidDisbursement.id, tenantId, summary: { amount: 4200 } });
}
