# Offline password blocklist

This directory vendors the SecLists `xato-net-10-million-passwords-100000.txt` sample for local common-password checks. `manifest.json` records the immutable upstream commit, original download URL, SHA-256, line count and retrieval date. The bytes in `common-100000.txt` are unchanged from that pinned file.

Source: [SecLists Common-Credentials](https://github.com/danielmiessler/SecLists/tree/27c08068f849227f2fc1c8f7f00afae365957b96/Passwords/Common-Credentials). Upstream attribution and MIT terms are included verbatim in [LICENSE.SecLists](LICENSE.SecLists). These terms describe the vendored dataset, not a project-wide licensing decision for HonoCraft.

The runtime checks the manifest version, file digest and line count before constructing a case-insensitive set. It preserves password whitespace; it never calls a third-party breach service. This sample is not comprehensive breach coverage. Updates require a reviewed release with matching data, manifest, attribution and loader version/size expectations.
