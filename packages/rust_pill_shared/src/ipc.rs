use std::io::{self, BufRead, Write};
use std::sync::{Mutex, OnceLock};

/// Read a newline-terminated IPC record. EOF after a partial record is not a
/// complete message, even when the bytes happen to be valid JSON.
pub fn read_complete_line(reader: &mut impl BufRead, line: &mut String) -> io::Result<bool> {
    line.clear();
    match reader.read_line(line)? {
        0 => Ok(false),
        _ if line.ends_with('\n') => Ok(true),
        _ => Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "unterminated pill IPC record",
        )),
    }
}

/// Write one serialized record and its delimiter. After any I/O failure the
/// stream must not be used again: an unknown prefix may have been written.
/// Dropping the writer does not guarantee that other handles are closed.
pub fn write_complete_line<W: Write>(writer: &mut Option<W>, record: &[u8]) -> io::Result<()> {
    let result = match writer.as_mut() {
        Some(writer) => writer
            .write_all(record)
            .and_then(|_| writer.write_all(b"\n"))
            .and_then(|_| writer.flush()),
        None => {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "pill IPC writer is unavailable",
            ))
        }
    };
    if result.is_err() {
        *writer = None;
    }
    result
}

/// Serialize callers' stdout records against each other and fail closed after
/// an ambiguous write. A successful write is not an application-level ack.
pub fn write_stdout_line(record: &[u8]) -> io::Result<()> {
    static STDOUT: OnceLock<Mutex<Option<io::Stdout>>> = OnceLock::new();
    let mut stdout = STDOUT
        .get_or_init(|| Mutex::new(Some(io::stdout())))
        .lock()
        .map_err(|_| io::Error::other("pill stdout writer is poisoned"))?;
    write_complete_line(&mut stdout, record)
}

#[cfg(test)]
mod tests {
    use super::{read_complete_line, write_complete_line};
    use std::io::{self, BufReader, Cursor, Read, Write};
    use std::{cell::RefCell, rc::Rc};

    #[test]
    fn an_ambiguous_partial_write_permanently_retires_the_writer() {
        struct Partial(Rc<RefCell<Vec<u8>>>);
        impl Write for Partial {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let mut written = self.0.borrow_mut();
                if written.is_empty() {
                    let length = bytes.len().min(2);
                    written.extend_from_slice(&bytes[..length]);
                    Ok(length)
                } else {
                    Err(io::ErrorKind::BrokenPipe.into())
                }
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let written = Rc::new(RefCell::new(Vec::new()));
        let mut writer = Some(Partial(written.clone()));
        assert_eq!(
            write_complete_line(&mut writer, b"first")
                .unwrap_err()
                .kind(),
            io::ErrorKind::BrokenPipe
        );
        assert!(writer.is_none());
        assert_eq!(
            write_complete_line(&mut writer, b"next")
                .unwrap_err()
                .kind(),
            io::ErrorKind::BrokenPipe
        );
        assert_eq!(&*written.borrow(), b"fi");
    }

    #[test]
    fn accepts_only_newline_terminated_records() {
        let mut reader = Cursor::new(b"{\"type\":\"first\"}\n\r\n{\"type\":\"last\"}".as_slice());
        let mut line = String::from("stale");
        assert!(read_complete_line(&mut reader, &mut line).unwrap());
        assert_eq!(line, "{\"type\":\"first\"}\n");
        assert!(read_complete_line(&mut reader, &mut line).unwrap());
        assert_eq!(line, "\r\n");
        assert_eq!(
            read_complete_line(&mut reader, &mut line)
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert!(!read_complete_line(&mut reader, &mut line).unwrap());
        assert!(line.is_empty());
    }

    #[test]
    fn reads_across_buffer_boundaries_and_propagates_io_errors() {
        let mut reader = BufReader::with_capacity(2, Cursor::new("héllo\n".as_bytes()));
        let mut line = String::new();
        assert!(read_complete_line(&mut reader, &mut line).unwrap());
        assert_eq!(line, "héllo\n");
        assert!(!read_complete_line(&mut reader, &mut line).unwrap());

        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::ErrorKind::PermissionDenied.into())
            }
        }
        let mut broken = BufReader::new(Broken);
        assert_eq!(
            read_complete_line(&mut broken, &mut line)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}
