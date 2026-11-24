export const REGISTRATION_TYPES = {
    IN: [
        {
            code: 'SCHOOL_REGISTRATION',
            label: 'School registration number',
            hint: 'Recognition / registration number issued by the state education department',
            dates: true,
            authority: true,
            maxLength: 64,
        },
        {
            code: 'UDISE',
            label: 'UDISE+ code',
            hint: '11-digit school code from the UDISE+ portal',
            pattern: /^[0-9]{11}$/,
            example: '09010101001',
            maxLength: 11,
        },
        {
            code: 'TRUST_NAME',
            label: 'Trust / society name',
            hint: 'Legal name of the managing body',
            maxLength: 200,
        },
        {
            code: 'TRUST_REGISTRATION',
            label: 'Trust / society registration number',
            hint: 'Registration number of the managing trust or society',
            dates: true,
            authority: true,
            maxLength: 64,
        },
        {
            code: 'PAN',
            label: 'PAN',
            hint: '10 characters, e.g. AAAPL1234C',
            pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
            example: 'AAAPL1234C',
            maxLength: 10,
        },
        {
            code: 'TAN',
            label: 'TAN',
            hint: '10 characters, e.g. DELA12345B',
            pattern: /^[A-Z]{4}[0-9]{5}[A-Z]$/,
            example: 'DELA12345B',
            maxLength: 10,
        },
        {
            code: 'GSTIN',
            label: 'GSTIN',
            hint: '15 characters, e.g. 07AAAPL1234C1Z5',
            pattern: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
            example: '07AAAPL1234C1Z5',
            maxLength: 15,
        },
    ],
};
export function registrationTypesFor(country) {
    return REGISTRATION_TYPES[(country ?? 'IN').toUpperCase()] ?? REGISTRATION_TYPES.IN;
}
