// Generado por cloud/scripts/sync-desktop-zpl.mjs desde apps/web/src/lib/label-logo.ts. No editar a mano.
(function (root) {

const loadImage = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('No se pudo leer la imagen del logo'));
    image.src = src;
});
// Logo subido para etiquetas: se guarda reducido (máximo 600 px) en PNG.
async function prepareLabelLogo(file) {
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type))
        throw new Error('El logo debe ser PNG, JPG, WEBP o SVG');
    if (file.size > 3000000)
        throw new Error('El logo supera 3 MB');
    const source = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.readAsDataURL(file);
    });
    const image = await loadImage(source);
    const scale = Math.min(1, 600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
}
// El logo a los puntos reales de la Zebra, en blanco y negro puro (la térmica
// no imprime grises): transparente = blanco, luminancia < 160 = negro. El
// ancho se redondea a múltiplos de 8 porque ^GFA va por bytes.
async function labelLogoBitmap(dataUrl, maxWidthDots, maxHeightDots) {
    if (!dataUrl)
        return null;
    const image = await loadImage(dataUrl);
    const scale = Math.min(maxWidthDots / image.naturalWidth, maxHeightDots / image.naturalHeight);
    const drawWidth = Math.max(8, Math.floor(image.naturalWidth * scale));
    const height = Math.max(1, Math.floor(image.naturalHeight * scale));
    const width = Math.ceil(drawWidth / 8) * 8;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, Math.floor((width - drawWidth) / 2), 0, drawWidth, height);
    const pixels = context.getImageData(0, 0, width, height);
    let hex = '';
    for (let y = 0; y < height; y++) {
        for (let byteX = 0; byteX < width; byteX += 8) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit++) {
                const offset = (y * width + byteX + bit) * 4;
                const luma = 0.299 * pixels.data[offset] + 0.587 * pixels.data[offset + 1] + 0.114 * pixels.data[offset + 2];
                const black = luma < 160;
                if (black)
                    byte |= 0x80 >> bit;
                const value = black ? 0 : 255;
                pixels.data[offset] = value;
                pixels.data[offset + 1] = value;
                pixels.data[offset + 2] = value;
                pixels.data[offset + 3] = 255;
            }
            hex += byte.toString(16).toUpperCase().padStart(2, '0');
        }
    }
    context.putImageData(pixels, 0, 0);
    return { width, height, hex, preview: canvas.toDataURL('image/png') };
}
const api = { prepareLabelLogo, labelLogoBitmap };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
