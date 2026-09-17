// Ad-hoc signs the packaged .app so it launches on Apple Silicon without a
// Developer ID certificate. Packaging invalidates Electron's inherited ad-hoc
// signature; without this the app dies with "Killed: 9" / "damaged".
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function adhocSign(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--verbose=1', app], { stdio: 'inherit' });
};
