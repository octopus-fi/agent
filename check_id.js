
function hexToBase64Url(hexString) {
    if (hexString.startsWith('0x')) {
        hexString = hexString.slice(2);
    }
    const buffer = Buffer.from(hexString, 'hex');
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

const userHex = "0x6ebce3ca4ef240368797f579db416a2bcff774811efa5d7440b4dd3648dd1fdd";
const jsonBase64 = "JxL8mY34-wspVDmp9Fi0HSahtrtfIDvDl1D9noTVg08";

const converted = hexToBase64Url(userHex);
console.log(`User Hex: ${userHex}`);
console.log(`Converted Base64Url: ${converted}`);
console.log(`JSON Base64Url:      ${jsonBase64}`);
console.log(`Match? ${converted === jsonBase64}`);
