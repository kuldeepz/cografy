package main

func helper() int {
	return 42
}

func run() int {
	return helper()
}

func main() {
	run()
}
