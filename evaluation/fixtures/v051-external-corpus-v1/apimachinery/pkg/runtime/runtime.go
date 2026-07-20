package runtime

type Object interface {
	DeepCopyObject() Object
}
