// Package blobstore defines the immutable, SHA-256 addressed blob storage
// interface (port of packages/blob-store/core).
package blobstore

import (
	"context"
	"errors"
	"io"
)

var (
	// ErrNotFound is returned by Get when no blob exists for the hash.
	ErrNotFound = errors.New("blob not found")
	// ErrInvalidHash is returned for hashes that are not lowercase hex SHA-256 digests.
	ErrInvalidHash = errors.New("Blob hash must be a lowercase hexadecimal SHA-256 digest")
	// ErrInvalidSize is returned for negative declared sizes.
	ErrInvalidSize = errors.New("Blob size must be a non-negative integer")
	// ErrSizeMismatch is returned when streamed bytes differ in length from the declared size.
	ErrSizeMismatch = errors.New("Blob size does not match declared size")
	// ErrHashMismatch is returned when streamed bytes do not hash to the requested hash.
	ErrHashMismatch = errors.New("Blob SHA-256 does not match requested hash")
	// ErrExistingMismatch is returned when a blob already exists with a different size.
	ErrExistingMismatch = errors.New("Existing blob does not match the declared size")
)

// PutInput describes a blob to store. Body is consumed as a stream.
type PutInput struct {
	Hash     string
	Body     io.Reader
	Size     int64
	MimeType string
}

// ReadResult is an open blob. The caller must Close Body.
type ReadResult struct {
	Body io.ReadCloser
	Size int64
}

// Store is an immutable content-addressed blob store.
type Store interface {
	Has(ctx context.Context, hash string) (bool, error)
	// Put verifies size and SHA-256 while writing; it is idempotent for existing blobs of equal size.
	Put(ctx context.Context, in PutInput) error
	// Get returns ErrNotFound when the blob is absent.
	Get(ctx context.Context, hash string) (*ReadResult, error)
	// Delete removes a blob; deleting a missing blob is not an error.
	Delete(ctx context.Context, hash string) error
}
