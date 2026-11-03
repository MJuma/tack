// Local installs go through a private npm mirror whose tarball URLs pnpm would otherwise pin in
// pnpm-lock.yaml. Dropping them (integrity hashes stay) lets the lockfile resolve against whatever
// registry is configured: the mirror locally, public npm in CI.
module.exports = {
    hooks: {
        afterAllResolved(lockfile) {
            for (const pkg of Object.values(lockfile.packages ?? {})) {
                const resolution = pkg.resolution;
                if (resolution?.integrity && resolution.tarball?.includes('/-/')) {
                    delete resolution.tarball;
                }
            }
            return lockfile;
        },
    },
};
