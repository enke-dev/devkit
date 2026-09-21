# The `+` in the tab bar

macOS draws a `+` at the right of a tab bar when something in the responder chain implements
`newWindowForTab:`. Nothing in tao does, so DevKit's tab bar has none: tabs can be opened with ⌘T and
from the File menu, dragged out, merged and cycled with ⌘⇧[ and ⌘⇧], but the one button every other
tabbed Mac app has is missing, and its absence reads as an unfinished app rather than as a missing
API.

## What was tried, and why it is not in the tree

Building a subclass of tao's window class with `ClassBuilder`, giving it `newWindowForTab:`, and
swapping a live window onto it with `object_setClass` — the move KVO makes, and the only way to add
a method to a class somebody else registered, since objc2 can define methods on classes it builds
and not on classes it finds.

It compiles, the window opens, and AppKit then aborts the process:

```
Assertion failed: (imp != NULL), function NSDP_getComputedPropertyValue,
file NSDynamicProperties.m, line 1004.
```

`NSDynamicProperties` resolves `@dynamic` accessors by looking them up on the class it is given. The
subclass is registered from Rust and carries none of the property metadata AppKit synthesised onto
the original, so the first window property AppKit resolves through that path finds no implementation
and the assertion fires. It is not a race and not a threading mistake: the crash is immediate and
repeatable, on the window's first appearance.

## What is left to try

- **`class_addMethod` on the existing class** rather than a subclass — the method would land on
  tao's own window class, which is what `NSDynamicProperties` already knows about. objc2 0.6 has no
  safe wrapper for it; whether the raw runtime call is reachable from the crates already in the tree
  (`objc2`, `objc2-app-kit`) needs checking. Adding a method to a class every DevKit window shares
  is also, unlike swizzling an instance, a change that cannot be undone.
- **The application delegate.** `newWindowForTab:` travels the responder chain, so an app delegate
  that implements it would do — but tao owns that object too, so it is the same problem one step
  further along.
- **Upstream.** tao already exposes the tabbing identifier and
  `set_allows_automatic_window_tabbing`; a `newWindowForTab:` hook is the missing third, and it
  belongs there rather than in an app that has to reach into tao's classes to install it.

Nothing here is blocking. ⌘T is the shortcut people use, and it works.
