package db

import (
	"context"
	"errors"
	"testing"
)

type fakeDB struct {
	Database
	committed bool
}

func (f *fakeDB) Transaction(_ context.Context, fn func(TransactionRepositories) error) error {
	if err := fn(nil); err != nil {
		return err
	}
	f.committed = true
	return nil
}

func TestInTransaction(t *testing.T) {
	f := &fakeDB{}
	v, err := InTransaction(context.Background(), f, func(TransactionRepositories) (int, error) { return 7, nil })
	if err != nil || v != 7 || !f.committed {
		t.Fatalf("%v %v %v", v, err, f.committed)
	}
	boom := errors.New("boom")
	f = &fakeDB{}
	v, err = InTransaction(context.Background(), f, func(TransactionRepositories) (int, error) { return 9, boom })
	if !errors.Is(err, boom) || v != 0 || f.committed {
		t.Fatalf("%v %v %v", v, err, f.committed)
	}
}
