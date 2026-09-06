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

let waitingForActionCompleted = false;
let scriptInjectTimeoutId = null;
let nextProcessTimeoutId = null;

function cancelPendingTimeouts() {
    if (scriptInjectTimeoutId) {
        clearTimeout(scriptInjectTimeoutId);
        scriptInjectTimeoutId = null;
    }
    if (nextProcessTimeoutId) {
        clearTimeout(nextProcessTimeoutId);
        nextProcessTimeoutId = null;
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    syncState(() => {
        if (message.action === 'START_FOLLOWING') {
            queue = message.usernames;
            currentIndex = 0;
            isRunning = true;
            isPaused = false;
            waitingForActionCompleted = false;
            rateLimitCount = 0;
            clearAutoPause();
            cancelPendingTimeouts();
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
            waitingForActionCompleted = false;
            rateLimitCount = 0;
            clearAutoPause();
            cancelPendingTimeouts();
            updateStatus("Stopped.", true);
            workTabId = null;
            saveState();
        }
        else if (message.action === 'PAUSE_FOLLOWING') {
            isPaused = true;
            clearAutoPause();
            cancelPendingTimeouts();
            updateStatus(`Paused manually. (${currentIndex}/${queue.length})`);
            saveState();
        }
        else if (message.action === 'RESUME_FOLLOWING') {
            isPaused = false;
            clearAutoPause();
            updateStatus(`Resuming... (${currentIndex}/${queue.length})`);
            saveState();
            if (!waitingForActionCompleted) {
                processNext();
            }
        }
        else if (message.action === 'GET_STATUS') {
            sendResponse({ isRunning, isPaused, statusText, stats, total: queue.length, resumeTime });
        }
        else if (message.action === 'ACTION_COMPLETED') {
            if (!isRunning) return;
            if (!waitingForActionCompleted) return; // Prevent duplicate events
            
            waitingForActionCompleted = false;
            cancelPendingTimeouts(); // Clean up any pending timeouts
            
            const username = queue[currentIndex];

            if (message.result === 'rate_limited') {
                // Do not increment currentIndex to retry this user later
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
            
            // Reset rate limit count on a successful interaction or missing user
            rateLimitCount = 0;
            stats.totalProcessed++;
            currentIndex++; // Move to next user
            
            if (message.result === 'followed' || message.result === 'already_following' || message.result === 'not_found') {
                chrome.storage.local.get(['followedUsers'], (result) => {
                    const db = result.followedUsers || {};
                    db[username.toLowerCase()] = true; // Mark as processed even if not found to prevent infinite retries
                    chrome.storage.local.set({ followedUsers: db });
                });
                if (message.result === 'followed') {
                    stats.newlyFollowed++;
                } else if (message.result === 'already_following') {
                    stats.alreadyFollowed++;
                }
            }
            
            const delay = Math.floor(Math.random() * 4000) + 3000;
            updateStatus(`Waiting ${(delay/1000).toFixed(1)}s... (${currentIndex}/${queue.length})`);
            saveState();
            
            nextProcessTimeoutId = setTimeout(() => {
                nextProcessTimeoutId = null;
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
        waitingForActionCompleted = false;
        updateStatus(`Finished! (${queue.length}/${queue.length})`, true);
        workTabId = null;
        saveState();
        return;
    }

    const username = queue[currentIndex];
    
    updateStatus(`Processing @${username} (${currentIndex + 1}/${queue.length})`);
    saveState();
    
    chrome.tabs.update(workTabId, { url: `https://x.com/${username}` }, (tab) => {
        // Wait for page to load before injecting
        waitingForActionCompleted = false;
        cancelPendingTimeouts();
        scriptInjectTimeoutId = setTimeout(() => {
            scriptInjectTimeoutId = null;
            if(!isRunning || isPaused) return;
            
            waitingForActionCompleted = true;
            chrome.scripting.executeScript({
                target: { tabId: workTabId },
                files: ['content.js']
            }).catch(err => {
                console.error("Error injecting script:", err);
                waitingForActionCompleted = false;
                stats.totalProcessed++;
                currentIndex++;
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

