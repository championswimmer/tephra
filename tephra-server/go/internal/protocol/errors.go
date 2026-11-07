package protocol

// ApiErrorCode is the closed set of API error codes.
type ApiErrorCode string

const (
	CodeVaultSyncModeMismatch ApiErrorCode = "VAULT_SYNC_MODE_MISMATCH"
	CodeObsidianUnavailable   ApiErrorCode = "OBSIDIAN_UNAVAILABLE"
	CodeObsidianLoginFailed   ApiErrorCode = "OBSIDIAN_LOGIN_FAILED"
	CodeObsidianMFARequired   ApiErrorCode = "OBSIDIAN_MFA_REQUIRED"
	CodeObsidianAuthExpired   ApiErrorCode = "OBSIDIAN_AUTH_EXPIRED"
	CodeObsidianSetupFailed   ApiErrorCode = "OBSIDIAN_SETUP_FAILED"
	CodeObsidianCheckoutMiss  ApiErrorCode = "OBSIDIAN_CHECKOUT_MISSING"
	CodeObsidianSyncFailed    ApiErrorCode = "OBSIDIAN_SYNC_FAILED"
	CodeObsidianSyncLimit     ApiErrorCode = "OBSIDIAN_SYNC_LIMIT"
	CodeObsidianReadOnly      ApiErrorCode = "OBSIDIAN_READ_ONLY"
	CodeObsidianRateLimit     ApiErrorCode = "OBSIDIAN_RATE_LIMIT"
	CodeAuthRequired          ApiErrorCode = "AUTH_REQUIRED"
	CodeTokenRevoked          ApiErrorCode = "TOKEN_REVOKED"
	CodeVaultNotFound         ApiErrorCode = "VAULT_NOT_FOUND"
	CodeVaultAccessDenied     ApiErrorCode = "VAULT_ACCESS_DENIED"
	CodeVaultNameTaken        ApiErrorCode = "VAULT_NAME_TAKEN"
	CodeVaultNameMismatch     ApiErrorCode = "VAULT_NAME_MISMATCH"
	CodeInvalidPath           ApiErrorCode = "INVALID_PATH"
	CodeInvalidManifest       ApiErrorCode = "INVALID_MANIFEST"
	CodeDuplicatePath         ApiErrorCode = "DUPLICATE_PATH"
	CodeDuplicateFileID       ApiErrorCode = "DUPLICATE_FILE_ID"
	CodeBlobTooLarge          ApiErrorCode = "BLOB_TOO_LARGE"
	CodeBlobHashMismatch      ApiErrorCode = "BLOB_HASH_MISMATCH"
	CodeBlobMissing           ApiErrorCode = "BLOB_MISSING"
	CodeEditConflict          ApiErrorCode = "EDIT_CONFLICT"
	CodeCommitFailed          ApiErrorCode = "COMMIT_FAILED"
	CodeIndexPending          ApiErrorCode = "INDEX_PENDING"
	CodeFileDeleted           ApiErrorCode = "FILE_DELETED"
	CodeAmbiguousPath         ApiErrorCode = "AMBIGUOUS_PATH"
	CodeInternalError         ApiErrorCode = "INTERNAL_ERROR"
)

// AllApiErrorCodes lists every code in the TS enum order.
var AllApiErrorCodes = []ApiErrorCode{
	CodeVaultSyncModeMismatch, CodeObsidianUnavailable, CodeObsidianLoginFailed, CodeObsidianMFARequired,
	CodeObsidianAuthExpired, CodeObsidianSetupFailed, CodeObsidianCheckoutMiss, CodeObsidianSyncFailed,
	CodeObsidianSyncLimit, CodeObsidianReadOnly, CodeObsidianRateLimit, CodeAuthRequired, CodeTokenRevoked,
	CodeVaultNotFound, CodeVaultAccessDenied, CodeVaultNameTaken, CodeVaultNameMismatch, CodeInvalidPath,
	CodeInvalidManifest, CodeDuplicatePath, CodeDuplicateFileID, CodeBlobTooLarge, CodeBlobHashMismatch,
	CodeBlobMissing, CodeEditConflict, CodeCommitFailed, CodeIndexPending, CodeFileDeleted,
	CodeAmbiguousPath, CodeInternalError,
}

// IsValid reports whether c is a known code.
func (c ApiErrorCode) IsValid() bool {
	for _, k := range AllApiErrorCodes {
		if k == c {
			return true
		}
	}
	return false
}

// ApiError is the inner object of the error envelope.
type ApiError struct {
	Code    ApiErrorCode `json:"code"`
	Message string       `json:"message"`
}

// ApiErrorResponse is the JSON error envelope: {"error":{"code","message"}}.
type ApiErrorResponse struct {
	Error ApiError `json:"error"`
}
