import type { SelectGroupOption } from 'naive-ui'

/**
 * Fake generators grouped by category, for every generator picker (a strategy, its exception, a
 * template path). The FakeGenerator ↔ faker mapping is documented in `@shared/types`.
 */
export const generatorOptions: SelectGroupOption[] = [
  {
    type: 'group',
    label: 'Person',
    key: 'person',
    children: [
      { label: 'First name', value: 'firstName' },
      { label: 'Surname', value: 'lastName' },
      { label: 'Full name', value: 'fullName' }
    ]
  },
  {
    type: 'group',
    label: 'Contact',
    key: 'contact',
    children: [
      { label: 'Email from ID (user1234@example.com)', value: 'userIdEmail' },
      {
        label: 'Email from ID, keep domain (user1234@your-domain)',
        value: 'userIdEmailKeepDomain'
      },
      { label: 'Email (example.com / .org / .net)', value: 'exampleEmail' },
      { label: 'Email (real provider domains)', value: 'email' },
      { label: 'Phone', value: 'phone' }
    ]
  },
  {
    type: 'group',
    label: 'Address',
    key: 'address',
    children: [
      { label: 'Street address (line 1)', value: 'streetAddress' },
      { label: 'Address line 2', value: 'secondaryAddress' },
      { label: 'City', value: 'city' },
      { label: 'State / region', value: 'state' },
      { label: 'Postcode', value: 'zipCode' },
      { label: 'Country', value: 'country' },
      { label: 'Country code (GB, US, NL)', value: 'countryCode' }
    ]
  },
  {
    type: 'group',
    label: 'Finance',
    key: 'finance',
    children: [
      { label: 'Credit card number', value: 'creditCardNumber' },
      { label: 'Credit card CVV', value: 'creditCardCVV' },
      { label: 'IBAN', value: 'iban' }
    ]
  },
  {
    type: 'group',
    label: 'Company',
    key: 'company',
    children: [{ label: 'Company name', value: 'companyName' }]
  },
  {
    type: 'group',
    label: 'Text',
    key: 'text',
    children: [
      { label: 'Lorem words (short — titles)', value: 'loremWords' },
      { label: 'Lorem sentence (medium)', value: 'loremSentence' },
      { label: 'Lorem paragraph (long — text columns)', value: 'loremParagraph' }
    ]
  },
  {
    type: 'group',
    label: 'Web',
    key: 'web',
    children: [
      { label: 'Avatar / portrait image URL', value: 'avatarUrl' },
      { label: 'Website URL', value: 'url' },
      { label: 'IP address (IPv4)', value: 'ipAddress' }
    ]
  },
  {
    type: 'group',
    label: 'Dates',
    key: 'dates',
    children: [{ label: 'Date of birth (YYYY-MM-DD)', value: 'dateOfBirth' }]
  }
]
