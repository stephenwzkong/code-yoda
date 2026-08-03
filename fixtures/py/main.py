from pkg.service import run


def main():
    return run()


def ambiguous(thing):
    # Nothing here says what `thing` is, so this can only ever be a name match.
    return thing.uniquely_named_method()
