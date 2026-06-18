#include <napi.h>

#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

#if defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#elif defined(__APPLE__)
#include <stdio.h>
#endif

namespace {

class FileDescriptor {
 public:
  explicit FileDescriptor(int value = -1) : value_(value) {}
  ~FileDescriptor() {
    if (value_ >= 0) {
      close(value_);
    }
  }

  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;

  FileDescriptor(FileDescriptor&& other) noexcept : value_(other.value_) {
    other.value_ = -1;
  }

  FileDescriptor& operator=(FileDescriptor&& other) noexcept {
    if (this != &other) {
      if (value_ >= 0) {
        close(value_);
      }
      value_ = other.value_;
      other.value_ = -1;
    }
    return *this;
  }

  int get() const { return value_; }

 private:
  int value_;
};

struct Entry {
  std::string path;
  bool directory;
  std::vector<std::uint8_t> content;
  mode_t mode;
};

struct PendingTemporaryFile {
  FileDescriptor parent_descriptor;
  FileDescriptor temporary_descriptor;
  std::string name;
};

std::mutex pending_temporary_files_mutex;
std::vector<PendingTemporaryFile> pending_temporary_files;
constexpr std::size_t kMaximumPendingTemporaryFiles = 64;

std::runtime_error SystemError(const std::string& operation,
                               const std::string& path,
                               int error_number = errno) {
  return std::runtime_error(operation + " \"" + path + "\": " +
                            std::strerror(error_number));
}

std::vector<std::string> SplitPath(const std::string& path) {
  if (path.empty() || path.front() == '/' || path.back() == '/' ||
      path.find('\\') != std::string::npos) {
    throw std::invalid_argument("Invalid template path: " + path);
  }

  std::vector<std::string> segments;
  std::size_t start = 0;
  while (start < path.size()) {
    const std::size_t separator = path.find('/', start);
    const std::size_t length =
        separator == std::string::npos ? path.size() - start
                                      : separator - start;
    const std::string segment = path.substr(start, length);
    if (segment.empty() || segment == "." || segment == "..") {
      throw std::invalid_argument("Invalid template path: " + path);
    }
    segments.push_back(segment);
    if (separator == std::string::npos) {
      break;
    }
    start = separator + 1;
  }
  return segments;
}

FileDescriptor DuplicateDescriptor(int descriptor) {
  const int duplicate = fcntl(descriptor, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) {
    throw SystemError("Could not duplicate destination descriptor", ".");
  }
  return FileDescriptor(duplicate);
}

FileDescriptor OpenOrCreateDirectory(int parent_descriptor,
                                     const std::string& name,
                                     const std::string& path) {
  int descriptor = openat(parent_descriptor, name.c_str(),
                          O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor >= 0) {
    return FileDescriptor(descriptor);
  }

  const int open_error = errno;
  if (open_error != ENOENT) {
    throw SystemError("Could not open template directory", path, open_error);
  }

  if (mkdirat(parent_descriptor, name.c_str(), 0755) != 0 &&
      errno != EEXIST) {
    throw SystemError("Could not create template directory", path);
  }

  descriptor = openat(parent_descriptor, name.c_str(),
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    throw SystemError("Could not anchor template directory", path);
  }
  return FileDescriptor(descriptor);
}

FileDescriptor OpenParentDirectory(int root_descriptor,
                                   const std::vector<std::string>& segments,
                                   const std::string& path) {
  FileDescriptor current = DuplicateDescriptor(root_descriptor);
  for (std::size_t index = 0; index + 1 < segments.size(); ++index) {
    current = OpenOrCreateDirectory(current.get(), segments[index], path);
  }
  return current;
}

void WriteCompleteFile(int descriptor,
                       const std::vector<std::uint8_t>& content,
                       const std::string& path,
                       bool fail_during_write) {
  std::size_t offset = 0;
  while (offset < content.size()) {
    std::size_t requested = content.size() - offset;
    if (fail_during_write) {
      requested = 1;
    }
    const ssize_t written =
        write(descriptor, content.data() + offset, requested);
    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }
      throw SystemError("Could not write temporary template file", path);
    }
    offset += static_cast<std::size_t>(written);
    if (fail_during_write) {
      throw std::runtime_error("Injected write failure for \"" + path +
                               "\"");
    }
  }
}

int RenameWithoutReplacement(int parent_descriptor,
                             const std::string& source,
                             const std::string& destination) {
#if defined(__linux__)
  return static_cast<int>(
      syscall(SYS_renameat2, parent_descriptor, source.c_str(),
              parent_descriptor, destination.c_str(), RENAME_NOREPLACE));
#elif defined(__APPLE__)
  return renameatx_np(parent_descriptor, source.c_str(), parent_descriptor,
                      destination.c_str(), RENAME_EXCL);
#else
#error "The Scaflow template native helper supports only macOS and Linux"
#endif
}

std::string TemporaryName() {
  static std::atomic<std::uint64_t> sequence{0};
  return ".scaflow-template-" + std::to_string(getpid()) + "-" +
         std::to_string(sequence.fetch_add(1, std::memory_order_relaxed)) +
         ".tmp";
}

int UnlinkAtRetryingInterrupts(int parent_descriptor,
                               const std::string& name) {
  int result;
  do {
    result = unlinkat(parent_descriptor, name.c_str(), 0);
  } while (result != 0 && errno == EINTR);
  return result;
}

int FstatRetryingInterrupts(int descriptor, struct stat* status) {
  int result;
  do {
    result = fstat(descriptor, status);
  } while (result != 0 && errno == EINTR);
  return result;
}

int FstatAtRetryingInterrupts(int parent_descriptor, const std::string& name,
                              struct stat* status, int flags) {
  int result;
  do {
    result = fstatat(parent_descriptor, name.c_str(), status, flags);
  } while (result != 0 && errno == EINTR);
  return result;
}

bool SameIdentity(const struct stat& status, dev_t device, ino_t inode) {
  return status.st_dev == device && status.st_ino == inode;
}

void RetainTemporaryFileForRecovery(int parent_descriptor,
                                    int temporary_descriptor,
                                    const std::string& temporary_name,
                                    const std::string& path) {
  std::lock_guard<std::mutex> lock(pending_temporary_files_mutex);
  if (pending_temporary_files.size() >= kMaximumPendingTemporaryFiles) {
    throw std::runtime_error(
        "Temporary template recovery capacity is exhausted");
  }
  try {
    pending_temporary_files.push_back(
        {DuplicateDescriptor(parent_descriptor),
         DuplicateDescriptor(temporary_descriptor), temporary_name});
  } catch (const std::exception& error) {
    throw std::runtime_error("Could not retain temporary template file \"" +
                             path + "\" for recovery: " + error.what());
  }
}

void RecoverPendingTemporaryFiles() {
  std::lock_guard<std::mutex> lock(pending_temporary_files_mutex);
  std::vector<PendingTemporaryFile> remaining;
  remaining.reserve(pending_temporary_files.size());
  std::string recovery_error;

  for (PendingTemporaryFile& pending : pending_temporary_files) {
    struct stat retained_parent_status {};
    if (FstatRetryingInterrupts(pending.parent_descriptor.get(),
                                &retained_parent_status) != 0) {
      if (recovery_error.empty()) {
        recovery_error =
            SystemError("Could not inspect retained template directory", ".")
                .what();
      }
      remaining.push_back(std::move(pending));
      continue;
    }
    if (!S_ISDIR(retained_parent_status.st_mode)) {
      continue;
    }

    struct stat retained_temporary_status {};
    if (FstatRetryingInterrupts(pending.temporary_descriptor.get(),
                                &retained_temporary_status) != 0) {
      if (recovery_error.empty()) {
        recovery_error =
            SystemError("Could not inspect retained temporary descriptor",
                        pending.name)
                .what();
      }
      remaining.push_back(std::move(pending));
      continue;
    }
    if (!S_ISREG(retained_temporary_status.st_mode)) {
      continue;
    }

    struct stat current_status {};
    if (FstatAtRetryingInterrupts(
            pending.parent_descriptor.get(), pending.name, &current_status,
            AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno != ENOENT) {
        if (recovery_error.empty()) {
          recovery_error =
              SystemError("Could not inspect retained temporary template file",
                          pending.name)
                  .what();
        }
        remaining.push_back(std::move(pending));
      }
      continue;
    }

    if (!S_ISREG(current_status.st_mode) ||
        !SameIdentity(current_status, retained_temporary_status.st_dev,
                      retained_temporary_status.st_ino)) {
      continue;
    }

    if (UnlinkAtRetryingInterrupts(pending.parent_descriptor.get(),
                                   pending.name) != 0) {
      if (recovery_error.empty()) {
        recovery_error =
            SystemError("Could not recover temporary template file",
                        pending.name)
                .what();
      }
      remaining.push_back(std::move(pending));
    }
  }

  pending_temporary_files = std::move(remaining);
  if (!recovery_error.empty()) {
    throw std::runtime_error(recovery_error);
  }
}

bool PublishFile(int parent_descriptor, const Entry& entry,
                 const std::string& name, bool fail_during_write,
                 bool fail_before_publish,
                 bool fail_identity_inspection,
                 const Napi::FunctionReference* after_temporary_file_created) {
  const std::string temporary_name = TemporaryName();
  const int raw_descriptor =
      openat(parent_descriptor, temporary_name.c_str(),
             O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (raw_descriptor < 0) {
    throw SystemError("Could not create temporary template file", entry.path);
  }

  FileDescriptor temporary_descriptor(raw_descriptor);
  bool published = false;
  bool skipped = false;
  std::string operation_error;
  try {
    if (after_temporary_file_created != nullptr) {
      after_temporary_file_created->Call({});
    }
    struct stat parent_status {};
    struct stat temporary_status {};
    if (fail_identity_inspection) {
      throw SystemError("Could not identify temporary template file",
                        entry.path, EIO);
    }
    if (FstatRetryingInterrupts(parent_descriptor, &parent_status) != 0 ||
        FstatRetryingInterrupts(temporary_descriptor.get(),
                                &temporary_status) != 0) {
      const int stat_error = errno;
      throw SystemError("Could not identify temporary template file",
                        entry.path, stat_error);
    }
    WriteCompleteFile(temporary_descriptor.get(), entry.content, entry.path,
                      fail_during_write);
    if (fchmod(temporary_descriptor.get(), entry.mode) != 0) {
      throw SystemError("Could not set template file mode", entry.path);
    }
    if (fsync(temporary_descriptor.get()) != 0) {
      throw SystemError("Could not sync temporary template file", entry.path);
    }
    if (fail_before_publish) {
      throw std::runtime_error("Injected publication failure for \"" +
                               entry.path + "\"");
    }

    if (RenameWithoutReplacement(parent_descriptor, temporary_name, name) ==
        0) {
      published = true;
    } else {
      const int rename_error = errno;
      if (rename_error == EEXIST) {
        skipped = true;
      } else {
        throw SystemError("Could not publish template file", entry.path,
                          rename_error);
      }
    }
  } catch (const std::exception& error) {
    operation_error = error.what();
  } catch (...) {
    operation_error = "Unknown template publication failure";
  }

  if (!published &&
      UnlinkAtRetryingInterrupts(parent_descriptor, temporary_name) != 0) {
    const int cleanup_error = errno;
    try {
      RetainTemporaryFileForRecovery(parent_descriptor,
                                     temporary_descriptor.get(),
                                     temporary_name, entry.path);
    } catch (const std::exception& recovery_error) {
      throw std::runtime_error(
          (operation_error.empty() ? "Could not skip existing template file"
                                   : operation_error) +
          "; cleanup failed: " + std::strerror(cleanup_error) +
          "; recovery unavailable: " + recovery_error.what());
    }
    throw std::runtime_error(
        (operation_error.empty() ? "Could not skip existing template file"
                                 : operation_error) +
        "; cleanup failed and was retained for recovery: " +
        std::strerror(cleanup_error));
  }

  if (!operation_error.empty()) {
    throw std::runtime_error(operation_error);
  }
  return !skipped;
}

std::vector<Entry> ParseEntries(const Napi::Array& values) {
  std::vector<Entry> entries;
  entries.reserve(values.Length());
  for (std::uint32_t index = 0; index < values.Length(); ++index) {
    const Napi::Value value = values.Get(index);
    if (!value.IsObject()) {
      throw std::invalid_argument("Template entries must be objects");
    }
    const Napi::Object object = value.As<Napi::Object>();
    const std::string path = object.Get("path").As<Napi::String>().Utf8Value();
    SplitPath(path);
    const std::string type = object.Get("type").As<Napi::String>().Utf8Value();

    if (type == "directory") {
      entries.push_back({path, true, {}, 0755});
      continue;
    }
    if (type != "file") {
      throw std::invalid_argument("Invalid template entry type for: " + path);
    }

    const Napi::Value content_value = object.Get("content");
    if (!content_value.IsBuffer()) {
      throw std::invalid_argument("Template file content must be a Buffer");
    }
    const Napi::Buffer<std::uint8_t> content =
        content_value.As<Napi::Buffer<std::uint8_t>>();
    const std::uint32_t mode =
        object.Get("mode").As<Napi::Number>().Uint32Value();
    if ((mode & ~0777U) != 0) {
      throw std::invalid_argument("Invalid template file mode for: " + path);
    }
    entries.push_back(
        {path, false,
         std::vector<std::uint8_t>(content.Data(),
                                   content.Data() + content.Length()),
         static_cast<mode_t>(mode)});
  }
  return entries;
}

Napi::Value RenderEntries(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    if (info.Length() < 2 ||
        (!info[0].IsString() && !info[0].IsNumber()) ||
        !info[1].IsArray()) {
      throw std::invalid_argument(
          "renderEntries requires a destination path or descriptor and entry array");
    }

    const std::vector<Entry> entries =
        ParseEntries(info[1].As<Napi::Array>());
    const Napi::Object options =
        info.Length() >= 3 && info[2].IsObject()
            ? info[2].As<Napi::Object>()
            : Napi::Object::New(env);

    FileDescriptor root;
    if (info[0].IsString()) {
      const std::string destination =
          info[0].As<Napi::String>().Utf8Value();
      const int raw_root =
          open(destination.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
      if (raw_root < 0) {
        throw SystemError("Could not open template destination", destination);
      }
      root = FileDescriptor(raw_root);
    } else {
      const int destination_descriptor =
          info[0].As<Napi::Number>().Int32Value();
      struct stat destination_stat {};
      if (FstatRetryingInterrupts(destination_descriptor,
                                  &destination_stat) != 0) {
        throw SystemError("Could not use template destination descriptor",
                          ".");
      }
      if (!S_ISDIR(destination_stat.st_mode)) {
        throw SystemError("Could not use template destination descriptor", ".",
                          ENOTDIR);
      }
      root = DuplicateDescriptor(destination_descriptor);
    }

    const Napi::Value after_open = options.Get("afterDestinationOpen");
    if (after_open.IsFunction()) {
      after_open.As<Napi::Function>().Call(env.Global(), {});
    }

    RecoverPendingTemporaryFiles();

    std::string fail_before_publish_path;
    std::string fail_during_write_path;
    std::string fail_identity_inspection_path;
    const Napi::Value write_failure_path =
        options.Get("failDuringWritePath");
    if (write_failure_path.IsString()) {
      fail_during_write_path =
          write_failure_path.As<Napi::String>().Utf8Value();
    }
    const Napi::Value failure_path = options.Get("failBeforePublishPath");
    if (failure_path.IsString()) {
      fail_before_publish_path =
          failure_path.As<Napi::String>().Utf8Value();
    }
    const Napi::Value identity_failure_path =
        options.Get("failIdentityInspectionPath");
    if (identity_failure_path.IsString()) {
      fail_identity_inspection_path =
          identity_failure_path.As<Napi::String>().Utf8Value();
    }
    Napi::FunctionReference after_temporary_file_created;
    const Napi::Value after_temporary_creation =
        options.Get("afterTemporaryFileCreated");
    if (after_temporary_creation.IsFunction()) {
      after_temporary_file_created =
          Napi::Persistent(after_temporary_creation.As<Napi::Function>());
    }

    Napi::Array created = Napi::Array::New(env);
    Napi::Array skipped = Napi::Array::New(env);
    std::uint32_t created_index = 0;
    std::uint32_t skipped_index = 0;

    for (const Entry& entry : entries) {
      const std::vector<std::string> segments = SplitPath(entry.path);
      if (entry.directory) {
        FileDescriptor current = DuplicateDescriptor(root.get());
        std::string current_path;
        for (const std::string& segment : segments) {
          current_path =
              current_path.empty() ? segment : current_path + "/" + segment;
          current =
              OpenOrCreateDirectory(current.get(), segment, current_path);
        }
        continue;
      }

      FileDescriptor parent =
          OpenParentDirectory(root.get(), segments, entry.path);
      const bool was_created =
          PublishFile(parent.get(), entry, segments.back(),
                      entry.path == fail_during_write_path,
                      entry.path == fail_before_publish_path,
                      entry.path == fail_identity_inspection_path,
                      after_temporary_file_created.IsEmpty()
                          ? nullptr
                          : &after_temporary_file_created);
      if (was_created) {
        created.Set(created_index++, entry.path);
      } else {
        skipped.Set(skipped_index++, entry.path);
      }
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("created", created);
    result.Set("skipped", skipped);
    return result;
  } catch (const std::exception& error) {
    Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("renderEntries", Napi::Function::New(env, RenderEntries));
  return exports;
}

}  // namespace

NODE_API_MODULE(scaflow_template_native, Initialize)
