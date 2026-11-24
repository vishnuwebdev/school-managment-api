/**
 * How a payment method is printed on receipts, invoices and billing PDFs (Indian wording).
 * One map for school fee payments and subscription payments; unknown codes print as given.
 */
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  BANK_TRANSFER: 'Bank transfer (NEFT/IMPS)',
  CHEQUE: 'Cheque',
  CARD: 'Card',
  ONLINE_GATEWAY: 'Online',
  OTHER: 'Other',
};

export const paymentMethodLabel = (code: string) => PAYMENT_METHOD_LABELS[code] ?? code;
