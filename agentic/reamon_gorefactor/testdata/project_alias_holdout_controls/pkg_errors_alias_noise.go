package errors

func aliasNoiseReference() string {
	stderrors := struct{ Is string }{Is: "stderrors.Is"}
	return stderrors.Is
}
