document.getElementById('startBtn').addEventListener('click', startProcess);
document.getElementById('stopBtn').addEventListener('click', stopProcess);
document.getElementById('pauseBtn').addEventListener('click', pauseProcess);
document.getElementById('resumeBtn').addEventListener('click', resumeProcess);
document.getElementById('fileInput').addEventListener('change', handleFileUpload);
document.getElementById('exportBtn').addEventListener('click', exportDatabase);
document.getElementById('importDb').addEventListener('change', importDatabase);
document.getElementById('addMoreBtn').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('fileInput').click();
});
document.getElementById('clearFilesBtn').addEventListener('click', (e) => {
    e.preventDefault();
    clearFiles();
});

let isRunning = false;
let savedFiles = [];
let savedText = "";

// Load initial state
loadDbCount();
chrome.storage.local.get(['savedFiles', 'savedText', 'manualText'], (result) => {
    if (result.manualText) {
        document.getElementById('manualInput').value = result.manualText;
    }
    if (result.savedFiles && result.savedFiles.length > 0) {
        savedFiles = result.savedFiles;
        savedText = result.savedText || "";
        updateFileListUI();
    }
});

// Save manual text as user types
document.getElementById('manualInput').addEventListener('input', (e) => {
    chrome.storage.local.set({ manualText: e.target.value });
});

function loadDbCount() {
    chrome.storage.local.get(['followedUsers'], (result) => {
        const db = result.followedUsers || {};
        document.getElementById('dbCount').innerText = Object.keys(db).length;
    });
}

function updateFileListUI() {
    if (savedFiles.length > 0) {
        document.getElementById('fileUploadLabel').style.display = 'none';
        document.getElementById('fileListContainer').style.display = 'block';
        document.getElementById('fileName').innerHTML = savedFiles.map(f => `• ${f.name}`).join('<br>');
    } else {
        document.getElementById('fileUploadLabel').style.display = 'flex';
        document.getElementById('fileListContainer').style.display = 'none';
        document.getElementById('fileName').innerHTML = '';
    }
}

function clearFiles() {
    savedFiles = [];
    savedText = "";
    chrome.storage.local.set({ savedFiles: [], savedText: "" });
    updateFileListUI();
}

function exportDatabase() {
    chrome.storage.local.get(['followedUsers'], (result) => {
        const db = result.followedUsers || {};
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(db));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "x_connect_pro_backup.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    });
}

async function importDatabase(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const importedDb = JSON.parse(text);
        
        chrome.storage.local.get(['followedUsers'], (result) => {
            const db = result.followedUsers || {};
            Object.assign(db, importedDb);
            chrome.storage.local.set({ followedUsers: db }, () => {
                alert("Database imported successfully!");
                loadDbCount();
            });
        });
    } catch (e) {
        alert("Invalid backup file! Please select a valid JSON backup.");
    }
    event.target.value = '';
}

let countdownInterval = null;

function startCountdown(resumeTime) {
    if (countdownInterval) clearInterval(countdownInterval);
    const timerText = document.getElementById('timerText');
    timerText.style.display = 'block';
    
    function update() {
        const remaining = resumeTime - Date.now();
        if (remaining <= 0) {
            timerText.innerText = "Resuming now...";
            clearInterval(countdownInterval);
            countdownInterval = null;
            return;
        }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        timerText.innerText = `⏳ Resuming in ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    update();
    countdownInterval = setInterval(update, 1000);
}

function stopCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = null;
    document.getElementById('timerText').style.display = 'none';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STATUS_UPDATE') {
        document.getElementById('statusText').innerText = message.text;
        
        if (message.resumeTime) {
            startCountdown(message.resumeTime);
        } else {
            stopCountdown();
        }
        
        if (message.isPaused !== undefined && isRunning) {
             setRunningUI(message.isPaused);
        }
        
        if (message.stats) {
            document.getElementById('newlyFollowed').innerText = message.stats.newlyFollowed;
            document.getElementById('alreadyFollowed').innerText = message.stats.alreadyFollowed;
            
            const progress = message.total > 0 ? (message.stats.totalProcessed / message.total) * 100 : 0;
            document.getElementById('progressBar').style.width = `${progress}%`;
        }

        if (message.finished) {
            resetUI();
            document.getElementById('progressBar').style.width = `100%`;
            if (message.stats && message.total > 0) {
                 document.getElementById('statusText').innerText = "Finished!";
            }
            loadDbCount();
            stopCountdown();
        }
    }
});

chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (response) => {
    if (response) {
        if (response.stats) {
             document.getElementById('newlyFollowed').innerText = response.stats.newlyFollowed;
             document.getElementById('alreadyFollowed').innerText = response.stats.alreadyFollowed;
             const progress = response.total > 0 ? (response.stats.totalProcessed / response.total) * 100 : 0;
             document.getElementById('progressBar').style.width = `${progress}%`;
        }
        
        if (response.resumeTime) {
            startCountdown(response.resumeTime);
        } else {
            stopCountdown();
        }
        
        if (response.isRunning) {
            setRunningUI(response.isPaused);
            document.getElementById('statusText').innerText = response.statusText;
        } else if (response.total > 0 && response.stats && response.stats.totalProcessed === response.total) {
            document.getElementById('progressContainer').style.display = 'block';
            document.getElementById('statusText').innerText = "Finished!";
            document.getElementById('progressBar').style.width = '100%';
        }
    }
});

// Set up PDF.js
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.disableWorker = true;
}

async function handleFileUpload(event) {
    const files = event.target.files;
    if (files.length > 0) {
        document.getElementById('statusText').innerText = "Reading files...";
        document.getElementById('progressContainer').style.display = 'block';
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            savedFiles.push({ name: file.name });
            
            if (file.name.toLowerCase().endsWith('.pdf')) {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
                    let pdfText = '';
                    for (let p = 1; p <= pdf.numPages; p++) {
                        const page = await pdf.getPage(p);
                        const textContent = await page.getTextContent();
                        pdfText += textContent.items.map(item => item.str).join(' ') + ' ';
                    }
                    savedText += " " + pdfText;
                } catch (err) {
                    console.error("Error parsing PDF:", file.name, err);
                    alert(`Could not read the PDF file: ${file.name}`);
                }
            } else {
                const text = await file.text();
                savedText += "\n" + text;
            }
        }
        
        chrome.storage.local.set({ savedFiles: savedFiles, savedText: savedText });
        updateFileListUI();
        
        document.getElementById('progressContainer').style.display = 'none';
        document.getElementById('statusText').innerText = "Ready";
    }
    // Reset file input
    event.target.value = '';
}

async function startProcess() {
    const manualText = document.getElementById('manualInput').value.trim();
    const fullText = manualText + "\n" + savedText;


    usernames = extractUsernames(fullText);

    if (usernames.length === 0) {
        alert("Could not find any valid usernames. Make sure they contain '@' or are formatted properly.");
        return;
    }

    chrome.storage.local.get(['followedUsers'], (result) => {
        const db = result.followedUsers || {};
        const newQueue = usernames.filter(u => !db[u.toLowerCase()]);
        const skipped = usernames.length - newQueue.length;
        
        if (newQueue.length === 0) {
            alert(`All ${usernames.length} usernames are already in your saved Database! Nothing new to follow.`);
            return;
        }

        if (skipped > 0) {
            alert(`Skipped ${skipped} users that are already in your Database.\nStarting with ${newQueue.length} new users.`);
        }

        setRunningUI(false);
        document.getElementById('newlyFollowed').innerText = '0';
        document.getElementById('alreadyFollowed').innerText = '0';
        document.getElementById('progressBar').style.width = '0%';
        
        chrome.runtime.sendMessage({
            action: 'START_FOLLOWING',
            usernames: newQueue
        });
    });
}

function stopProcess() {
    chrome.runtime.sendMessage({ action: 'STOP_FOLLOWING' });
    resetUI();
    document.getElementById('statusText').innerText = "Stopped.";
}

function pauseProcess() {
    chrome.runtime.sendMessage({ action: 'PAUSE_FOLLOWING' });
    setRunningUI(true);
}

function resumeProcess() {
    chrome.runtime.sendMessage({ action: 'RESUME_FOLLOWING' });
    setRunningUI(false);
}

function extractUsernames(text) {
    const usernames = [];
    const atMatches = text.matchAll(/@([a-zA-Z0-9_]{1,15})/g);
    for (const match of atMatches) {
        usernames.push(match[1]);
    }
    const urlMatches = text.matchAll(/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]{1,15})/g);
    for (const match of urlMatches) {
        usernames.push(match[1]);
    }
    if (usernames.length === 0) {
        const words = text.split(/[\s,]+/);
        for (let word of words) {
            let clean = word.replace(/[^a-zA-Z0-9_]/g, '');
            if (clean && clean.length > 0 && clean.length <= 15) {
                usernames.push(clean);
            }
        }
    }
    return [...new Set(usernames)].filter(u => u);
}

function setRunningUI(paused = false) {
    isRunning = true;
    document.getElementById('startBtn').style.display = 'none';
    const actionButtons = document.getElementById('actionButtons');
    actionButtons.style.display = 'flex';
    
    if (paused) {
        document.getElementById('pauseBtn').style.display = 'none';
        document.getElementById('resumeBtn').style.display = 'block';
    } else {
        document.getElementById('pauseBtn').style.display = 'block';
        document.getElementById('resumeBtn').style.display = 'none';
    }

    document.getElementById('manualInput').disabled = true;
    document.getElementById('fileInput').disabled = true;
    document.getElementById('progressContainer').style.display = 'block';
}

function resetUI() {
    isRunning = false;
    document.getElementById('startBtn').style.display = 'block';
    document.getElementById('actionButtons').style.display = 'none';
    document.getElementById('manualInput').disabled = false;
    document.getElementById('fileInput').disabled = false;
}
