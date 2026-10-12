import { execSync, spawn } from 'child_process';

/**
 * Gathers the diff, pulls changed files from the repository, and restarts the bot.
 * @returns {boolean} Returns true if updates were pulled and the bot restarted.
 */
export function updateBot() {
    try {
        console.log('Checking repository state...');

        // Fetch latest changes from remote without merging
        execSync('git fetch', { stdio: 'pipe' });

        // Get the current active branch name
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();

        // 2. Gather the diff/list of files that have changed between local state and repo state
        const diffFiles = execSync(`git diff --name-only HEAD origin/${currentBranch}`).toString().trim();

        if (!diffFiles) {
            console.log('No changes found between local and repo state.');
            return false;
        }

        console.log('--- Detected Changes ---');
        console.log(diffFiles);
        console.log('------------------------');

        // 3. Pull the updated files from the repo (this writes the changes to disk)
        console.log(`Pulling updates from origin/${currentBranch}...`);
        execSync(`git pull origin ${currentBranch}`, { stdio: 'inherit' });

        console.log('Files updated successfully. Restarting process...');

        // 4. Restart the Node.js process
        restartBot();
        return true;

    } catch (error) {
        console.error('Failed to execute auto-update:', error.message);
        return false;
    }
}

/**
 * Restarts the current Node.js process cleanly.
 */
function restartBot() {
    const subprocess = spawn(process.argv[0], process.argv.slice(1), {
        detached: true,
        stdio: 'inherit',
    });
    
    subprocess.unref();
    process.exit(0);
}
