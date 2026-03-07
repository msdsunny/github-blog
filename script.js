function extractUrl(line) {
    // if the line already looks like a URL, just return it
    const trimmed = line.trim();
    if (/^https?:\/\//.test(trimmed)) return trimmed;
    // try to pull src from an <img> tag
    const match = trimmed.match(/src\s*=\s*"([^"]+)"/i);
    if (match) return match[1];
    // fallback: return original line (user may supply something else)
    return trimmed;
}

function generateHtml(rawLines) {
    const urls = rawLines
        .map(l => extractUrl(l))
        .filter(Boolean);
    return urls.map(u => `<div align="center"><img src="${u}"></div>`).join("\n");
}

function wrapImages(content) {
    // use DOM to wrap img elements so we don't accidentally wrap text
    const container = document.createElement('div');
    container.innerHTML = content;
    const imgs = container.querySelectorAll('img');
    imgs.forEach(img => {
        const parent = img.parentElement;
        if (parent && parent.tagName.toLowerCase() === 'div' && parent.getAttribute('align') === 'center') {
            // already wrapped; skip
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.setAttribute('align', 'center');
        img.replaceWith(wrapper);
        wrapper.appendChild(img);
    });
    return container.innerHTML;
}

const inputArea = document.getElementById('url');
const outputArea = document.getElementById('output');
const previewArea = document.getElementById('preview');
const copyBtn = document.getElementById('copy');
const toggleOutputBtn = document.getElementById('toggle-output');
const toggleUploadBtn = document.getElementById('toggle-upload');
const uploadBlock = document.getElementById('upload-block');
const outputSection = document.getElementById('output-section');
// credential inputs for session storage
const repoInput = document.getElementById('repo');
const pathInput = document.getElementById('path');
const tokenInput = document.getElementById('token');

function looksLikeUrl(s) {
    // basic check for http(s) urls
    return /^https?:\/\//i.test(s);
}

function processContent(raw) {
    if (!raw.trim()) {
        outputArea.value = '';
        previewArea.innerHTML = '';
        copyBtn.disabled = true;
        return;
    }
    let result;
    if (/\<img\b/i.test(raw)) {
        // if there are img tags, check whether any have legitimate URL srcs
        const tmp = document.createElement('div');
        tmp.innerHTML = raw;
        const imgs = tmp.querySelectorAll('img');
        const hasValidUrl = Array.from(imgs).some(i => looksLikeUrl(i.getAttribute('src') || ''));
        
        if (hasValidUrl) {
            // wrap images with valid URLs
            result = wrapImages(raw);
        } else {
            // no valid URLs found - remove non-URL img tags and divs
            const cleaned = tmp.cloneNode(true);
            const badImgs = Array.from(cleaned.querySelectorAll('img')).filter(i => !looksLikeUrl(i.getAttribute('src') || ''));
            badImgs.forEach(img => {
                const parent = img.parentElement;
                // if wrapped in <div align="center">, remove the wrapper
                if (parent && parent.tagName.toLowerCase() === 'div' && parent.getAttribute('align') === 'center') {
                    parent.remove();
                } else {
                    img.remove();
                }
            });
            result = cleaned.innerHTML.trim();
        }
    } else {
        const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (lines.length > 0 && lines.every(looksLikeUrl)) {
            // treat as URL list
            result = generateHtml(lines);
        } else {
            // leave arbitrary text alone (maybe blog content without <img>)
            result = raw;
        }
    }
    outputArea.value = result;
    previewArea.innerHTML = result;
    copyBtn.disabled = result === '';
}

// debounced save to localStorage
let saveTimer = null;
function debouncedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        localStorage.setItem('inputContent', inputArea.value);
    }, 500);
}

// fire on input change: update preview instantly, save to storage with debounce
inputArea.addEventListener('input', () => {
    processContent(inputArea.value);
    debouncedSave();
});

document.getElementById('generate').addEventListener('click', () => {
    processContent(inputArea.value);
});

toggleUploadBtn.addEventListener('click', () => {
    uploadBlock.classList.toggle('active');
});

toggleOutputBtn.addEventListener('click', () => {
    const isVisible = outputSection.style.display !== 'none';
    outputSection.style.display = isVisible ? 'none' : 'flex';
    toggleOutputBtn.textContent = isVisible ? 'Output' : 'Hide Output';
});

// persist credentials in sessionStorage
function saveCreds() {
    sessionStorage.setItem('githubRepo', repoInput.value);
    sessionStorage.setItem('githubPath', pathInput.value);
    sessionStorage.setItem('githubToken', tokenInput.value);
}

// if the fields exist, hook up persistence
if (repoInput) repoInput.addEventListener('input', saveCreds);
if (pathInput) pathInput.addEventListener('input', saveCreds);
if (tokenInput) tokenInput.addEventListener('input', saveCreds);

// restore on load
window.addEventListener('load', () => {
    if (sessionStorage.getItem('githubRepo')) repoInput.value = sessionStorage.getItem('githubRepo');
    if (sessionStorage.getItem('githubPath')) pathInput.value = sessionStorage.getItem('githubPath');
    if (sessionStorage.getItem('githubToken')) tokenInput.value = sessionStorage.getItem('githubToken');
    // restore input content from localStorage
    const saved = localStorage.getItem('inputContent');
    if (saved) {
        inputArea.value = saved;
        processContent(saved);
    }
});

document.getElementById('copy').addEventListener('click', () => {
    outputArea.select();
    outputArea.setSelectionRange(0, 99999); /* for mobile */
    document.execCommand('copy');
    alert('Copied to clipboard!');
});

document.getElementById('copy').addEventListener('click', () => {
    const output = document.getElementById('output');
    output.select();
    output.setSelectionRange(0, 99999); /* for mobile */
    document.execCommand('copy');
    alert('Copied to clipboard!');
});

// ------ upload section --------------------------------------------------
const dropzone = document.getElementById('dropzone');
const status = document.getElementById('upload-status');

function showStatus(msg, isError) {
    status.textContent = msg;
    status.style.color = isError ? 'red' : '#333';
}

function uploadImage(blob) {
    return new Promise((resolve, reject) => {
        let repoInput = document.getElementById('repo').value.trim();
        const path = document.getElementById('path').value.trim() || '';
        const token = document.getElementById('token').value.trim();
        if (!repoInput || !token) {
            showStatus('Repository and token are required', true);
            reject('missing repo/token');
            return;
        }
        // handle full GitHub URL
        if (repoInput.startsWith('https://github.com/')) {
            const parts = repoInput.split('/').slice(3, 5);
            if (parts.length === 2) {
                repoInput = parts.join('/');
            } else {
                showStatus('Invalid GitHub URL format', true);
                reject('bad url');
                return;
            }
        }
        // validate owner/repo format
        const repoParts = repoInput.split('/');
        if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
            showStatus('Repo must be in owner/repo format (or full GitHub URL)', true);
            reject('bad repo');
            return;
        }
        const [owner, repository] = repoParts;
        const filename = `image-${Date.now()}.png`;
        const fullPath = path ? `${path.replace(/\/+$/,'')}/${filename}` : filename;

        const reader = new FileReader();
        reader.onload = () => {
            const b64 = reader.result.split(',')[1];
            const url = `https://api.github.com/repos/${owner}/${repository}/contents/${fullPath}`;
            fetch(url, {
                method: 'PUT',
                headers: {
                    Authorization: `token ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: 'Upload via helper',
                    content: b64
                })
            }).then(r => r.json())
              .then(data => {
                  if (data && data.content && data.content.download_url) {
                      showStatus('Upload successful');
                      resolve(data.content.download_url);
                  } else {
                      showStatus('Upload failed', true);
                      console.error('upload error', data);
                      reject(data);
                  }
              }).catch(err => {
                  showStatus('Upload error', true);
                  console.error(err);
                  reject(err);
              });
        };
        reader.readAsDataURL(blob);
    });
}

function insertSnippet(url) {
    const snippet = `<div align="center"><img src="${url}" /></div>`;
    const textarea = inputArea;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + snippet + after;
    const pos = start + snippet.length;
    textarea.selectionStart = textarea.selectionEnd = pos;
    processContent(textarea.value);
}

function handleFiles(files) {
    for (const file of files) {
        if (file.type.startsWith('image/')) {
            uploadImage(file).then(insertSnippet);
        }
    }
}

// drag/drop on modal dropzone
['dragenter','dragover'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
        e.preventDefault();
        dropzone.classList.add('dragover');
        // ensure modal open
        uploadBlock.classList.add('active');
    });
});
['dragleave','drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
    });
});
dropzone.addEventListener('drop', e => {
    e.preventDefault();
    uploadBlock.classList.add('active');
    handleFiles(e.dataTransfer.files);
});

// paste into input area
inputArea.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const blob = item.getAsFile();
            uploadImage(blob).then(insertSnippet);
            break;
        }
    }
});

// drop onto input area
inputArea.addEventListener('dragover', e => e.preventDefault());
inputArea.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) {
        handleFiles(e.dataTransfer.files);
    }
});
