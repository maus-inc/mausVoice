#[path = "../ort_download.rs"]
mod ort_download;

use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const ARCHIVE: &str = "runtime.tgz";
const PINNED_BYTES: &[u8] = b"pinned ONNX archive fixture";

enum Reply {
    Http(u16, &'static [u8]),
    NoHeaders,
    DripHeaders,
    DelayBody,
}

fn server(replies: Vec<(&'static str, Reply)>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let worker = thread::spawn(move || {
        let mut stalled = Vec::new();
        let mut slow_replies = Vec::new();
        for (path, reply) in replies {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "no request for {path}");
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("could not accept test request: {error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut lines = BufReader::new(&socket).lines();
            assert_eq!(
                lines.next().unwrap().unwrap(),
                format!("GET {path}/{ARCHIVE} HTTP/1.1")
            );
            for line in lines {
                if line.unwrap().is_empty() {
                    break;
                }
            }
            match reply {
                Reply::Http(status, body) => {
                    write!(
                        socket,
                        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .unwrap();
                    socket.write_all(body).unwrap();
                }
                Reply::NoHeaders => stalled.push(socket),
                Reply::DripHeaders | Reply::DelayBody => {
                    slow_replies.push(thread::spawn(move || {
                        let _ = send_slow_reply(&mut socket, reply);
                    }));
                }
            }
        }
        for slow_reply in slow_replies {
            slow_reply.join().unwrap();
        }
    });
    (address, worker)
}

fn send_slow_reply(socket: &mut std::net::TcpStream, reply: Reply) -> io::Result<()> {
    socket.write_all(b"HTTP/1.1 200 Fixture\r\n")?;
    if matches!(reply, Reply::DripHeaders) {
        thread::sleep(Duration::from_millis(300));
    }
    write!(socket, "Content-Length: {}\r\n", PINNED_BYTES.len())?;
    if matches!(reply, Reply::DripHeaders) {
        thread::sleep(Duration::from_millis(300));
    }
    socket.write_all(b"Connection: close\r\n\r\n")?;
    if matches!(reply, Reply::DelayBody) {
        thread::sleep(Duration::from_millis(700));
    }
    socket.write_all(PINNED_BYTES)
}

fn agent(header_timeout: Duration) -> ureq::Agent {
    ureq::Agent::new_with_config(
        ort_download::download_config(header_timeout)
            .proxy(None)
            .build(),
    )
}

#[test]
fn skips_404_retries_503_and_only_publishes_verified_mirror_bytes() {
    let (address, worker) = server(vec![
        ("/primary", Reply::Http(404, b"")),
        ("/busy", Reply::Http(503, b"")),
        ("/busy", Reply::Http(503, b"")),
        ("/busy", Reply::Http(503, b"")),
        ("/wrong", Reply::Http(200, b"wrong bytes")),
        ("/mirror", Reply::Http(200, PINNED_BYTES)),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join(ARCHIVE);
    let digest = format!("{:x}", Sha256::digest(PINNED_BYTES));
    let bases =
        ["primary", "busy", "wrong", "mirror"].map(|source| format!("http://{address}/{source}"));
    let delays = std::cell::RefCell::new(Vec::new());
    let result = ort_download::download_verified(
        (ARCHIVE, &digest),
        &archive,
        &bases,
        &agent(Duration::from_secs(2)),
        |delay| delays.borrow_mut().push(delay),
    );
    worker.join().unwrap();
    result.unwrap();
    assert_eq!(
        delays.into_inner(),
        [Duration::from_secs(2), Duration::from_secs(4)]
    );
    assert_eq!(std::fs::read(&archive).unwrap(), PINNED_BYTES);
    assert_eq!(dir.path().read_dir().unwrap().count(), 1);
}

#[test]
fn missing_response_headers_do_not_prevent_mirror_fallback() {
    let (address, worker) = server(vec![
        ("/silent", Reply::NoHeaders),
        ("/silent", Reply::NoHeaders),
        ("/silent", Reply::NoHeaders),
        ("/mirror", Reply::Http(200, PINNED_BYTES)),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join(ARCHIVE);
    let digest = format!("{:x}", Sha256::digest(PINNED_BYTES));
    let bases = ["silent", "mirror"].map(|source| format!("http://{address}/{source}"));
    let result = ort_download::download_verified(
        (ARCHIVE, &digest),
        &archive,
        &bases,
        &agent(Duration::from_millis(300)),
        |_| {},
    );
    worker.join().unwrap();
    result.unwrap();
    assert_eq!(std::fs::read(&archive).unwrap(), PINNED_BYTES);
}

#[test]
fn corrupt_mirrors_leave_no_files_or_credentials_in_errors() {
    let (address, worker) = server(vec![("/mirror", Reply::Http(200, b"wrong bytes"))]);
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join(ARCHIVE);
    let digest = format!("{:x}", Sha256::digest(PINNED_BYTES));
    let bases = [format!(
        "http://fixture-user:fixture-credential@{address}/mirror"
    )];
    let result = ort_download::download_verified(
        (ARCHIVE, &digest),
        &archive,
        &bases,
        &agent(Duration::from_secs(2)),
        |_| panic!("a digest mismatch cannot be retried"),
    );
    worker.join().unwrap();
    let error = result.unwrap_err();
    assert!(error.contains("source 1: SHA-256 mismatch"));
    assert!(!error.contains("fixture-user") && !error.contains("fixture-credential"));
    assert_eq!(dir.path().read_dir().unwrap().count(), 0);
}

#[test]
fn partial_response_headers_cannot_extend_the_header_deadline() {
    let (address, worker) = server(vec![
        ("/drip", Reply::DripHeaders),
        ("/drip", Reply::DripHeaders),
        ("/drip", Reply::DripHeaders),
        ("/mirror", Reply::Http(200, PINNED_BYTES)),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join(ARCHIVE);
    let digest = format!("{:x}", Sha256::digest(PINNED_BYTES));
    let bases = ["drip", "mirror"].map(|source| format!("http://{address}/{source}"));
    let result = ort_download::download_verified(
        (ARCHIVE, &digest),
        &archive,
        &bases,
        &agent(Duration::from_millis(450)),
        |_| {},
    );
    worker.join().unwrap();
    result.unwrap();
    assert_eq!(std::fs::read(&archive).unwrap(), PINNED_BYTES);
}

#[test]
fn body_can_arrive_after_the_header_deadline() {
    let (address, worker) = server(vec![("/slow-body", Reply::DelayBody)]);
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join(ARCHIVE);
    let digest = format!("{:x}", Sha256::digest(PINNED_BYTES));
    let result = ort_download::download_verified(
        (ARCHIVE, &digest),
        &archive,
        &[format!("http://{address}/slow-body")],
        &agent(Duration::from_millis(450)),
        |_| panic!("body reads must not inherit the header deadline"),
    );
    worker.join().unwrap();
    result.unwrap();
    assert_eq!(std::fs::read(&archive).unwrap(), PINNED_BYTES);
}
