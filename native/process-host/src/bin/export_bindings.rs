use process_host::protocol;

use std::fs;
use std::path::PathBuf;

fn main() {
    let output_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/runtime/src/services/processBroker/processHostProtocol.generated.ts");
    let output = protocol::typescript_bindings();

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).expect("create generated binding directory");
    }
    fs::write(&output_path, output).expect("write generated TypeScript bindings");
    println!("generated {}", output_path.display());
}
