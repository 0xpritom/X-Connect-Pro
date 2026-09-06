(async function() {
    // Extra wait for the DOM to settle after injection
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log("Twitter Auto Follower: Checking page...");

    function findButton() {
        const buttons = document.querySelectorAll('[role="button"]');
        for (const btn of buttons) {
            const text = btn.innerText || btn.textContent;
            const cleanText = text.trim();
            // Look for Follow button
            if (cleanText === 'Follow') {
                return { element: btn, action: 'follow' };
            }
            // Look for Following button (means already followed)
            if (cleanText === 'Following') {
                return { element: btn, action: 'following' };
            }
            if (cleanText === 'Pending') {
                return { element: btn, action: 'pending' };
            }
        }
        return null;
    }

    let btnInfo = findButton();
    let retries = 0;
    
    // Retry finding button a few times in case page is still rendering
    while (!btnInfo && retries < 4) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        btnInfo = findButton();
        retries++;
    }

    if (!btnInfo) {
        console.log("Twitter Auto Follower: Button not found. Skipping.");
        chrome.runtime.sendMessage({ action: 'ACTION_COMPLETED', result: 'not_found' });
        return;
    }

    if (btnInfo.action === 'following' || btnInfo.action === 'pending') {
        console.log("Twitter Auto Follower: Already following. Skipping.");
        chrome.runtime.sendMessage({ action: 'ACTION_COMPLETED', result: 'already_following' });
    } else if (btnInfo.action === 'follow') {
        console.log("Twitter Auto Follower: Clicking Follow.");
        btnInfo.element.click();
        
        // Wait briefly to allow click action to register and check for toasts
        await new Promise(resolve => setTimeout(resolve, 2500));
        
        // Check for rate limit toast
        const pageText = document.body.innerText.toLowerCase();
        if (pageText.includes('rate limited') || pageText.includes('unable to follow') || pageText.includes('try again later')) {
            console.log("Twitter Auto Follower: Rate limit detected.");
            chrome.runtime.sendMessage({ action: 'ACTION_COMPLETED', result: 'rate_limited' });
        } else {
            chrome.runtime.sendMessage({ action: 'ACTION_COMPLETED', result: 'followed' });
        }
    }
})();
