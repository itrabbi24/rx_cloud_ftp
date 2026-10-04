// Stamps Windows version resources onto the built executables.
// pkg inherits the Node.js runtime's resource block, so without this the
// shipped exes report "Node.js 18.5.0" in the file properties and the GUI
// reports 0.0.0.0 with empty product/company fields.
// Usage: node stamp-version.js [file.exe ...]   (defaults to the three builds)
const fs = require('fs');
const path = require('path');
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');

const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkgJson.version;

const INFO = {
  CompanyName: 'ARG RABBI',
  ProductName: 'Rx Cloude',
  FileDescription: 'Rx Cloude - Portable Cloud Drive Server',
  FileVersion: version,
  ProductVersion: version,
  LegalCopyright: `Copyright (C) ${new Date().getFullYear()} ARG RABBI`,
  OriginalFilename: '',
  InternalName: 'RxCloude',
  Comments: 'Portable zero-install cloud drive server',
};

const defaults = ['dist/RxCloudeEngine.exe', 'dist/RxCloudeServer.exe', 'dist/RxCloude.exe'];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaults;

let failed = 0;
for (const target of targets) {
  const file = path.isAbsolute(target) ? target : path.join(__dirname, '..', target);
  if (!fs.existsSync(file)) {
    console.warn(`[stamp] skipped (not found): ${target}`);
    failed++;
    continue;
  }
  try {
    const exe = NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
    const res = NtExecutableResource.from(exe);

    const entries = Resource.VersionInfo.fromEntries(res.entries);
    let vi = entries[0];
    if (!vi) {
      vi = Resource.VersionInfo.createEmpty();
      vi.setFileVersion(version);
      vi.setProductVersion(version);
    }

    let langs = vi.getAllLanguagesForStringValues();
    if (!langs.length) langs = [{ lang: 1033, codepage: 1200 }]; // en-US, UTF-16

    for (const lang of langs) {
      vi.setStringValues(lang, { ...INFO, OriginalFilename: path.basename(file) });
    }
    vi.setFileVersion(version);
    vi.setProductVersion(version);
    vi.outputToResourceEntries(res.entries);

    res.outputResource(exe);
    fs.writeFileSync(file, Buffer.from(exe.generate()));
    console.log(`[stamp] ${path.basename(file)} -> FileVersion ${version}, ProductName "${INFO.ProductName}"`);
  } catch (err) {
    console.error(`[stamp] FAILED for ${path.basename(file)}: ${err.message}`);
    failed++;
  }
}

if (failed) {
  console.error(`[stamp] ${failed} file(s) could not be stamped`);
  process.exit(1);
}
console.log(`[stamp] all ${targets.length} executables stamped with version ${version}`);
