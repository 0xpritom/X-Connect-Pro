let queue = [];
let currentIndex = 0;
let isRunning = false;
let isPaused = false;
let workTabId = null;
let statusText = "Ready";
let rateLimitCount = 0;
let resumeTime = null;

let stats = {
    newlyFollowed: 0,
    alreadyFollowed: 0,
    totalProcessed: 0
};

// Load state on service worker wake up
function syncState(callback) {
    chrome.storage.local.get(['appState'], (res) => {
        if (res.appState) {
            queue = res.appState.queue || [];
            currentIndex = res.appState.currentIndex || 0;
            isRunning = res.appState.isRunning || false;
            isPaused = res.appState.isPaused || false;
            workTabId = res.appState.workTabId || null;
            rateLimitCount = res.appState.rateLimitCount || 0;
            stats = res.appState.stats || stats;
            statusText = res.appState.statusText || "Ready";
            resumeTime = res.appState.resumeTime || null;
        }
        if (callback) callback();
    });
}

syncState();

function saveState() {
    chrome.storage.local.set({
        appState: { queue, currentIndex, isRunning, isPaused, workTabId, rateLimitCount, stats, statusText, resumeTime }
    });
}

function clearAutoPause() {
    chrome.alarms.clear('autoResumeAlarm');
    resumeTime = null;
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'autoResumeAlarm') {
        syncState(() => {
            if (isPaused && isRunning) {
                isPaused = false;
                resumeTime = null;
                updateStatus(`Resuming after wait... (${currentIndex}/${queue.length})`);
                saveState();
                processNext();
            }
        });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    syncState(() => {
        if (message.action === 'START_FOLLOWING') {
            queue = message.usernames;
            currentIndex = 0;
            isRunning = true;
            isPaused = false;
            rateLimitCount = 0;
            clearAutoPause();
            stats = { newlyFollowed: 0, alreadyFollowed: 0, totalProcessed: 0 };
            
            updateStatus(`Starting... (0/${queue.length})`);
            saveState();
            
            chrome.tabs.create({ url: 'https://x.com', active: false }, (tab) => {
                workTabId = tab.id;
                saveState();
                processNext();
            });
        } 
        else if (message.action === 'STOP_FOLLOWING') {
            isRunning = false;
            isPaused = false;
            rateLimitCount = 0;
            clearAutoPause();
            updateStatus("Stopped.", true);
            workTabId = null;
            saveState();
        }
        else if (message.action === 'PAUSE_FOLLOWING') {
            isPaused = true;
            clearAutoPause();
            updateStatus(`Paused manually. (${currentIndex}/${queue.length})`);
            saveState();
        }
        else if (message.action === 'RESUME_FOLLOWING') {
            isPaused = false;
            clearAutoPause();
            updateStatus(`Resuming... (${currentIndex}/${queue.length})`);
            saveState();
            processNext();
        }
        else if (message.action === 'GET_STATUS') {
            sendResponse({ isRunning, isPaused, statusText, stats, total: queue.length, resumeTime });
        }
        else if (message.action === 'ACTION_COMPLETED') {
            if (!isRunning) return;
            
            const username = queue[currentIndex - 1];

            if (message.result === 'rate_limited') {
                currentIndex--; // Revert index to retry this user later
                isPaused = true;
                rateLimitCount++;
                
                let delayInMinutes = 0;
                if (rateLimitCount === 1) delayInMinutes = 10;
                else if (rateLimitCount === 2) delayInMinutes = 15;
                else if (rateLimitCount === 3) delayInMinutes = 20;

                if (delayInMinutes > 0) {
                    resumeTime = Date.now() + (delayInMinutes * 60 * 1000);
                    chrome.alarms.create('autoResumeAlarm', { delayInMinutes });
                    updateStatus(`⚠️ Rate limited! Auto-paused for ${delayInMinutes}m...`);
                } else {
                    resumeTime = null;
                    updateStatus(`🚫 Blocked 4 times! Permanently Paused.`);
                }
                saveState();
                return;
            }
            
            // Reset rate limit count on a successful interaction
            rateLimitCount = 0;
            stats.totalProcessed++;
            
            if (message.result === 'followed' || message.result === 'already_following') {
                chrome.storage.local.get(['followedUsers'], (result) => {
                    const db = result.followedUsers || {};
                    db[username.toLowerCase()] = true;
                    chrome.storage.local.set({ followedUsers: db });
                });
                if (message.result === 'followed') {
                    stats.newlyFollowed++;
                } else {
                    stats.alreadyFollowed++;
                }
            }
            
            const delay = Math.floor(Math.random() * 4000) + 3000;
            updateStatus(`Waiting ${(delay/1000).toFixed(1)}s... (${currentIndex}/${queue.length})`);
            saveState();
            
            setTimeout(() => {
                if (!isPaused) {
                    processNext();
                }
            }, delay);
        }
    });
    return true; // async response
});

function processNext() {
    if (!isRunning || isPaused) return;
    
    if (currentIndex >= queue.length) {
        isRunning = false;
        isPaused = false;
        updateStatus(`Finished! (${queue.length}/${queue.length})`, true);
        workTabId = null;
        saveState();
        return;
    }

    const username = queue[currentIndex];
    currentIndex++;
    
    updateStatus(`Processing @${username} (${currentIndex}/${queue.length})`);
    saveState();
    
    chrome.tabs.update(workTabId, { url: `https://x.com/${username}` }, (tab) => {
        // Wait for page to load before injecting
        setTimeout(() => {
            if(!isRunning || isPaused) return;
            chrome.scripting.executeScript({
                target: { tabId: workTabId },
                files: ['content.js']
            }).catch(err => {
                console.error("Error injecting script:", err);
                stats.totalProcessed++;
                saveState();
                processNext();
            });
        }, 5000); 
    });
}

function updateStatus(text, finished = false) {
    statusText = text;
    chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        text: text,
        finished: finished,
        stats: stats,
        total: queue.length,
        isPaused: isPaused,
        resumeTime: resumeTime
    }).catch(() => {});
}

