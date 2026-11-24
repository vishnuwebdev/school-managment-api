/** The school's letterhead for printed documents: name, address, contact, colour and logo. */
export async function loadPdfBranding(s, tenantId) {
    const b = await s.schoolSetup.documentBranding(tenantId);
    let logo = null;
    if (b.logo_file_id) {
        // An unreadable logo must never block a document.
        const f = await s.files.read(tenantId, b.logo_file_id).catch(() => null);
        if (f)
            logo = { bytes: f.data, mime: f.mime };
    }
    return {
        raw: b,
        school_name: b.school_name,
        address: [b.address.line1, b.address.line2, b.address.city, b.address.postal_code]
            .filter(Boolean)
            .join(', '),
        contact: [b.phone, b.email].filter(Boolean).join('  ·  '),
        footer_text: b.footer_text,
        primary_color: b.primary_color,
        logo,
    };
}
