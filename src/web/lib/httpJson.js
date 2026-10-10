// HTTP headers require byte-safe text. JSON Unicode escapes preserve the payload.
export function headerJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}
