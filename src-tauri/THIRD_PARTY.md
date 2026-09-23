# Native third-party notices

Darkroom includes LibRaw 0.21.1 through `libraw_rs_vendor` 1.0.0, copyright LibRaw LLC and its contributors. LibRaw is available under LGPL 2.1 or CDDL 1.0. Both license texts accompany this application.

The exact LibRaw source and Rust binding used to build the app are in `src-tauri/vendor/libraw_rs_vendor` in the Darkroom source distribution. Darkroom modifies the binding's build script to build one native archive, use platform-appropriate threading flags, and generate only the required C API bindings. The LibRaw C/C++ source is unchanged.

Upstream: <https://www.libraw.org/> and <https://github.com/mgolub2/libraw_rs_vendor>.

Other Rust dependencies and their exact versions are recorded in `src-tauri/Cargo.lock`; JavaScript dependencies are recorded in `package-lock.json`. Their license notices remain in their respective source packages. The separately supplied Nikon SDK runtime includes its own Third Party Legal Notices.
