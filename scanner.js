// scanner.js
export const patterns = [
    {
        name: 'Credit Card (Generic)',
        regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
        mask: (match) => {
            if (match.length === 16) return match.slice(0,4) + '-****-****-' + match.slice(-4);
            return match.slice(0,4) + '-****-' + match.slice(-4);
        }
    },
    // يمكنك إضافة المزيد من الأنماط هنا، مثلاً:
    // {
    //     name: 'Yemeni Phone Number',
    //     regex: /\b(77[0-9]{7}|7[0-9]{8})\b/g,
    //     mask: (match) => match.slice(0,3) + '*******'
    // }
];

export function scanMessageForSensitiveData(messageText) {
    const detected = [];
    for (const pattern of patterns) {
        let match;
        pattern.regex.lastIndex = 0;
        while ((match = pattern.regex.exec(messageText)) !== null) {
            detected.push({
                type: pattern.name,
                originalValue: match[0],
                maskedValue: pattern.mask(match[0])
            });
        }
    }
    return detected;
}
