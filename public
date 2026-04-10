// ─── STATE ────────────────────────────────────────────────────────────────────
var selectedFile = null;
var patternResult = null;

// ─── UPLOAD HANDLING ──────────────────────────────────────────────────────────
function handleFile(input) {
  var f = input.files[0];
  if (!f) return;
  selectedFile = f;
  var url = URL.createObjectURL(f);
  document.getElementById('previewImg').src = url;
  document.getElementById('uploadInner').style.display = 'none';
  document.getElementById('previewWrap').style.display = 'block';
  document.getElementById('convertBtn').disabled = false;
  document.getElementById('result-section').style.display = 'none';
}

function resetUpload() {
  selectedFile = null;
  patternResult = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('previewImg').src = '';
  document.getElementById('uploadInner').style.display = 'block';
  document.getElementById('previewWrap').style.display = 'none';
  document.getElementById('convertBtn').disabled = true;
  document.getElementById('result-section').style.display = 'none';
}

// Drag and drop
var zone = document.getElementById('uploadZone');
zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.classList.add('dragover'); });
zone.addEventListener('dragleave', function() { zone.classList.remove('dragover'); });
zone.addEventListener('drop', function(e) {
  e.preventDefault();
  zone.classList.remove('dragover');
  var f = e.dataTransfer.files[0];
  if (f && (f.type === 'image/jpeg' || f.type === 'image/png')) {
    var dt = new DataTransfer();
    dt.items.add(f);
    document.getElementById('fileInput').files = dt.files;
    handleFile(document.getElementById('fileInput'));
  }
});

// ─── CONVERT ──────────────────────────────────────────────────────────────────
async function convert() {
  if (!selectedFile) return;

  showLoading('Analysing your image...');
  document.getElementById('convertBtn').disabled = true;

  var fd = new FormData();
  fd.append('image', selectedFile);
  fd.append('sensitivity', document.getElementById('sensitivity').value);
  fd.append('thickness', document.getElementById('thickness').value);

  try {
    updateLoading('Generating your embroidery pattern...');
    var res = await fetch('/api/convert', { method: 'POST', body: fd });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Conversion failed');

    updateLoading('Almost there...');
    patternResult = data;
    showResult(data);

  } catch (e) {
    hideLoading();
    alert('Sorry, something went wrong: ' + e.message);
  } finally {
    hideLoading();
    document.getElementById('convertBtn').disabled = false;
  }
}

function showResult(data) {
  var pd = data.patternData;

  document.getElementById('patternPreviewImg').src = 'data:image/png;base64,' + data.patternImageB64;
  document.getElementById('originalPreviewImg').src = 'data:image/jpeg;base64,' + data.originalImageB64;
  document.getElementById('patternTitle').textContent = pd.title || 'My Pattern';
  document.getElementById('patternDesc').textContent = pd.description || '';
  document.getElementById('diffBadge').textContent = pd.difficulty || 'Beginner';
  document.getElementById('stitchTips').textContent = pd.stitchSuggestions || '';

  var colorsGrid = document.getElementById('colorsGrid');
  colorsGrid.innerHTML = '';
  (pd.dmcColors || []).forEach(function(c) {
    var chip = document.createElement('div');
    chip.className = 'color-chip';
    chip.innerHTML =
      '<div class="color-swatch" style="background:' + (c.hex || '#ccc') + '"></div>' +
      '<div class="color-info">' +
        '<span class="color-code">DMC ' + c.code + '</span>' +
        '<span class="color-name">' + c.name + '</span>' +
      '</div>';
    colorsGrid.appendChild(chip);
  });

  document.getElementById('result-section').style.display = 'block';
  document.getElementById('result-section').scrollIntoView({ behavior: 'smooth' });
}

function switchPreview(type) {
  document.querySelectorAll('.ptab').forEach(function(t) { t.classList.remove('active'); });
  event.target.classList.add('active');
  if (type === 'pattern') {
    document.getElementById('patternPreviewImg').style.display = 'block';
    document.getElementById('originalPreviewImg').style.display = 'none';
  } else {
    document.getElementById('patternPreviewImg').style.display = 'none';
    document.getElementById('originalPreviewImg').style.display = 'block';
  }
}

// ─── CIRCLE CLIP HELPER ───────────────────────────────────────────────────────
function clipImageToCircle(dataUrl) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() {
      var size = Math.min(img.width, img.height);
      var canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      var ctx = canvas.getContext('2d');
      // White background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      // Clip to circle
      ctx.beginPath();
      ctx.arc(size/2, size/2, size/2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      // Draw image centered
      var sx = (img.width - size) / 2;
      var sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ─── PDF GENERATION ───────────────────────────────────────────────────────────
// A4 dimensions in mm: 210 x 297
// Hoop sizes in mm (diameter)
var HOOPS = [
  { label: '3" Hoop',  mm: 76.2  },
  { label: '4" Hoop',  mm: 101.6 },
  { label: '5" Hoop',  mm: 127.0 },
  { label: '6" Hoop',  mm: 152.4 },
  { label: '7" Hoop',  mm: 177.8 },
  { label: '8" Hoop',  mm: 203.2 },
];

async function generatePatternPDF() {
  var { jsPDF } = window.jspdf;
  var doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  var pd = patternResult.patternData;
  var W = 210; var H = 297;

  // ── PAGE 1: Cover / intro ──
  // Background
  doc.setFillColor(250, 247, 244);
  doc.rect(0, 0, W, H, 'F');

  // Top accent bar
  doc.setFillColor(92, 122, 82);
  doc.rect(0, 0, W, 8, 'F');

  // Logo area
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.setTextColor(92, 122, 82);
  doc.text('Stitchify', W/2, 30, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(122, 101, 88);
  doc.text('Hand Embroidery Pattern', W/2, 38, { align: 'center' });

  // Original image
  try {
    var origImg = 'data:image/jpeg;base64,' + patternResult.originalImageB64;
    doc.addImage(origImg, 'JPEG', 30, 48, 150, 110, undefined, 'MEDIUM');
  } catch(e) {}

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(45, 32, 24);
  doc.text(pd.title || 'My Embroidery Pattern', W/2, 172, { align: 'center' });

  // Description
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(122, 101, 88);
  var descLines = doc.splitTextToSize(pd.description || '', 150);
  doc.text(descLines, W/2, 182, { align: 'center' });

  // Difficulty
  doc.setFillColor(237, 244, 234);
  doc.roundedRect(75, 192, 60, 10, 5, 5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(92, 122, 82);
  doc.text('Difficulty: ' + (pd.difficulty || 'Beginner'), W/2, 199, { align: 'center' });

  // DMC Colors
  var yc = 210;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(45, 32, 24);
  doc.text('DMC Thread Colors', 24, yc);

  var colors = pd.dmcColors || [];
  var cx = 24;
  colors.forEach(function(c, i) {
    if (i > 0 && i % 3 === 0) { cx = 24; yc += 18; }
    var x = cx + (i % 3) * 58;
    var hex = c.hex || '#cccccc';
    var r = parseInt(hex.slice(1,3),16);
    var g = parseInt(hex.slice(3,5),16);
    var b = parseInt(hex.slice(5,7),16);
    doc.setFillColor(r,g,b);
    doc.circle(x + 5, yc + 8, 5, 'F');
    doc.setDrawColor(180,180,180);
    doc.circle(x + 5, yc + 8, 5, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(45,32,24);
    doc.text('DMC ' + c.code, x + 13, yc + 7);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(122,101,88);
    doc.text(c.name, x + 13, yc + 12);
  });

  // Stitch suggestions
  var ys = yc + 26;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(45,32,24);
  doc.text('Stitch Suggestions', 24, ys);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(122,101,88);
  var tipLines = doc.splitTextToSize(pd.stitchSuggestions || '', 162);
  doc.text(tipLines, 24, ys + 7);

  // Personal use note
  doc.setFontSize(8);
  doc.setTextColor(180,160,150);
  doc.text('This pattern is for personal use only. Please do not sell, distribute or share.', W/2, H - 10, { align: 'center' });

  // Bottom bar
  doc.setFillColor(92, 122, 82);
  doc.rect(0, H - 6, W, 6, 'F');

  // ── PAGES 2-7: One page per hoop size ──
  for (var h = 0; h < HOOPS.length; h++) {
    doc.addPage();
    var hoop = HOOPS[h];

    // Background
    doc.setFillColor(250, 247, 244);
    doc.rect(0, 0, W, H, 'F');

    // Top bar
    doc.setFillColor(92, 122, 82);
    doc.rect(0, 0, W, 8, 'F');

    // Header
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(92, 122, 82);
    doc.text('Stitchify', 24, 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(122, 101, 88);
    doc.text(pd.title || 'My Pattern', 24, 27);

    // Hoop size label - right aligned
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(45, 32, 24);
    doc.text(hoop.label, W - 24, 22, { align: 'right' });

    // Separator line
    doc.setDrawColor(200, 185, 170);
    doc.setLineWidth(0.3);
    doc.line(24, 32, W - 24, 32);

    // Calculate hoop position - centered on page
    var r = hoop.mm / 2;
    var cx2 = W / 2;
    var cy2 = H / 2 + 10;

    // Make sure it fits on the page
    if (cy2 + r > H - 30) cy2 = H - 30 - r;
    if (cy2 - r < 40) cy2 = 40 + r;

    // Outer hoop ring (wood effect)
    doc.setDrawColor(180, 140, 80);
    doc.setLineWidth(4.5);
    doc.circle(cx2, cy2, r + 5);

    doc.setDrawColor(210, 180, 120);
    doc.setLineWidth(2);
    doc.circle(cx2, cy2, r + 6.5);

    doc.setDrawColor(150, 110, 60);
    doc.setLineWidth(1);
    doc.circle(cx2, cy2, r + 3);

    // Fabric background inside hoop
    doc.setFillColor(249, 246, 240);
    doc.circle(cx2, cy2, r + 2, 'F');

    // Dashed circle guide
    doc.setDrawColor(180, 160, 140);
    doc.setLineWidth(0.4);
    doc.setLineDashPattern([3, 3], 0);
    doc.circle(cx2, cy2, r);
    doc.setLineDashPattern([], 0);

    // Pattern image inside hoop - pre-clip to circle using canvas
    try {
      var clippedDataUrl = await clipImageToCircle(
        'data:image/png;base64,' + patternResult.patternImageB64
      );
      var imgSize = (r - 1) * 2;
      var imgX = cx2 - (imgSize / 2);
      var imgY = cy2 - (imgSize / 2);
      doc.addImage(clippedDataUrl, 'PNG', imgX, imgY, imgSize, imgSize, undefined, 'FAST');
    } catch(e) { console.error('Image clip error:', e); }

    // Hoop size label below
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(45, 32, 24);
    doc.text(hoop.label, cx2, cy2 + r + 14, { align: 'center' });

    // Print instruction
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(150, 130, 120);
    doc.text('Print on A4 — choose "Fit to Page". The hoop guide above is true to size.', cx2, H - 16, { align: 'center' });
    doc.text('For personal use only.', cx2, H - 11, { align: 'center' });

    // Bottom bar
    doc.setFillColor(92, 122, 82);
    doc.rect(0, H - 6, W, 6, 'F');
  }

  return doc;
}

// ─── ZIP DOWNLOAD ─────────────────────────────────────────────────────────────
async function downloadZip() {
  showLoading('Creating your pattern PDF...');

  try {
    // Generate pattern PDF
    var patternDoc = await generatePatternPDF();
    var patternPdfBytes = patternDoc.output('arraybuffer');

    updateLoading('Fetching Beginner\'s Guide...');

    // Fetch the hardcoded beginner's guide from server
    var guideRes = await fetch('/beginners-guide.pdf');
    if (!guideRes.ok) throw new Error('Could not load Beginner\'s Guide');
    var guideBytes = await guideRes.arrayBuffer();

    updateLoading('Packaging your ZIP file...');

    // Create ZIP
    var zip = new JSZip();
    var folderName = (patternResult.patternData.title || 'MyPattern').replace(/[^a-zA-Z0-9]/g, '_');
    var folder = zip.folder(folderName);
    folder.file(folderName + '_Pattern.pdf', patternPdfBytes);
    folder.file('Hand_Embroidery_Beginners_Guide.pdf', guideBytes);

    var zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

    // Download
    var url = URL.createObjectURL(zipBlob);
    var a = document.createElement('a');
    a.href = url;
    a.download = folderName + '_EmbroideryPack.zip';
    a.click();
    URL.revokeObjectURL(url);

    hideLoading();
    confetti();

  } catch(e) {
    hideLoading();
    alert('Download failed: ' + e.message);
  }
}

// ─── LOADING ──────────────────────────────────────────────────────────────────
function showLoading(text) {
  document.getElementById('loadingText').textContent = text || 'Loading...';
  document.getElementById('loadingOverlay').style.display = 'flex';
}
function updateLoading(text) {
  document.getElementById('loadingText').textContent = text;
}
function hideLoading() {
  document.getElementById('loadingOverlay').style.display = 'none';
}

// ─── CONFETTI ─────────────────────────────────────────────────────────────────
function confetti() {
  var c = document.getElementById('cf');
  var cols = ['#5c7a52','#c97b6b','#c4973a','#7a9e6e','#edf4ea','#faeee9','#fdf3e0','#fff'];
  for (var i = 0; i < 120; i++) {
    var p = document.createElement('div');
    p.className = 'cfp';
    var sz = Math.random() * 10 + 5;
    p.style.cssText = 'left:' + Math.random()*100 + '%;width:' + sz + 'px;height:' + sz + 'px;background:' + cols[Math.floor(Math.random()*cols.length)] + ';border-radius:' + (Math.random()>.5?'50%':'3px') + ';animation-duration:' + (Math.random()*2+2.5) + 's;animation-delay:' + (Math.random()*1) + 's;transform:rotate(' + (Math.random()*360) + 'deg)';
    c.appendChild(p);
    setTimeout(function() { if(p.parentNode) p.remove(); }, 5000);
  }
}
